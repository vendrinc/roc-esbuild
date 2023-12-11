#include <errno.h>
#include <setjmp.h>
#include <signal.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <stdint.h>

// If you get an error about node_api.h not being found, run this to find out
// the include path to use:
//
// $ node -e "console.log(path.resolve(process.execPath, '..', '..', 'include',
// 'node'))"
#include <node_api.h>

// Zero-sized types are not part of the C standard, but both clang and gcc have
// an extension to the C standard which supports ZSTs like this.
typedef struct {
} Unit;

// This is not volatile because it's only ever set inside a signal handler,
// which according to chatGPT is fine.
//
// (Also, clang gives a warning if it's marked volatile, because
// setjmp and longjmp expect non-volatile arguments, and you can't cast
// the arguments to (jmp_buf) to avoid that warning because jmp_buf is
// an array type, and you can't cast array types.)
jmp_buf jump_on_crash;

// These are all volatile because they're used in signal handlers but can be set
// outside the signal handler.
volatile int last_signal;
volatile char *last_roc_crash_msg;

void signal_handler(int sig) {
  // Store the signal we encountered, and jump back to the handler
  last_signal = sig;
  last_roc_crash_msg = NULL;

  longjmp(jump_on_crash, 1);
}

void *roc_alloc(size_t size, unsigned int u32align) {
  size_t align = (size_t)u32align;

  // Note: aligned_alloc only accepts alignments that are
  // at least sizeof(void*) and also a power of two,
  // so make sure it satisfies both of those.

  // aligned_alloc also requires that the given size is a multiple
  // of the alignment, so round to the nearest multiple of align.
  size = (size + align - 1) & ~(align - 1);

  return aligned_alloc(align, size);
}

void *roc_realloc(void *ptr, size_t new_size, size_t old_size,
                  unsigned int alignment) {
  return realloc(ptr, new_size);
}

void roc_dealloc(void *ptr, unsigned int alignment) { free(ptr); }

void *roc_memcpy(void *dest, const void *src, size_t n) {
  return memcpy(dest, src, n);
}

void *roc_memset(void *str, int c, size_t n) { return memset(str, c, n); }

// Reference counting

// If the refcount is set to this, that means the allocation is
// stored in readonly memory in the binary, and we must not
// attempt to increment or decrement it; if we do, we'll segfault!
const ssize_t REFCOUNT_READONLY = 0;
const ssize_t REFCOUNT_ONE = (ssize_t)PTRDIFF_MIN;
const size_t MASK = (size_t)PTRDIFF_MIN;

// Increment reference count, given a pointer to the first element in a
// collection. We don't need to check for overflow because in order to overflow
// a usize worth of refcounts, you'd need to somehow have more pointers in
// memory than the OS's virtual address space can hold.
void incref(uint8_t *bytes, uint32_t alignment) {
  ssize_t *refcount_ptr = ((ssize_t *)bytes) - 1;
  ssize_t refcount = *refcount_ptr;

  if (refcount != REFCOUNT_READONLY) {
    *refcount_ptr = refcount + 1;
  }
}

// Decrement reference count, given a pointer to the first byte of a
// collection's elements. Then call roc_dealloc if nothing is referencing this
// collection anymore.
void decref_heap_bytes(uint8_t *bytes, uint32_t alignment) {
  size_t extra_bytes = (sizeof(size_t) >= (size_t)alignment)
                           ? sizeof(size_t)
                           : (size_t)alignment;
  ssize_t *refcount_ptr = ((ssize_t *)bytes) - 1;
  ssize_t refcount = *refcount_ptr;

  if (refcount == REFCOUNT_ONE) {
    void *original_allocation =
        (void *)(refcount_ptr - (extra_bytes - sizeof(size_t)));

    roc_dealloc(original_allocation, alignment);
  } else if (refcount != REFCOUNT_READONLY) {
    *refcount_ptr = refcount - 1;
  }
}

// RocBytes (List U8)

struct RocBytes {
  uint8_t *bytes;
  size_t len;
  size_t capacity;
};

struct RocBytes empty_rocbytes() {
  struct RocBytes ret = {
      .len = 0,
      .bytes = NULL,
      .capacity = 0,
  };

  return ret;
}

struct RocBytes init_roc_bytes(uint8_t *bytes, size_t len, size_t capacity) {
  if (len == 0) {
    return empty_rocbytes();
  } else {
    struct RocBytes ret;
    size_t refcount_size = sizeof(size_t);
    uint8_t *new_refcount =
        (uint8_t *)roc_alloc(len + refcount_size, __alignof__(size_t));

    if (new_refcount == NULL) {
      // TODO handle this more gracefully!
      fprintf(stderr, "roc_alloc failed during init_roc_bytes in nodeJS; aborting\n");
      abort();
    }

    uint8_t *new_content = new_refcount + refcount_size;

    ((ssize_t *)new_refcount)[0] = REFCOUNT_ONE;

    memcpy(new_content, bytes, len);

    ret.bytes = new_content;
    ret.len = len;
    ret.capacity = capacity;

    return ret;
  }
}

// RocStr

struct RocStr {
  uint8_t *bytes;
  size_t len;
  size_t capacity;
};

struct RocStr empty_roc_str() {
  struct RocStr ret = {
      .len = 0,
      .bytes = NULL,
      .capacity = MASK,
  };

  return ret;
}

struct RocBytes empty_roc_bytes() {
  struct RocBytes ret = {
      .len = 0,
      .bytes = NULL,
      .capacity = MASK,
  };

  return ret;
}

// Record the small string's length in the last byte of the given stack
// allocation
void write_small_str_len(size_t len, struct RocStr *str) {
  ((uint8_t *)str)[sizeof(struct RocStr) - 1] = (uint8_t)len | 0b10000000;
}

struct RocStr roc_str_init_small(uint8_t *bytes, size_t len) {
  // Start out with zeroed memory, so that
  // if we end up comparing two small RocStr values
  // for equality, we won't risk memory garbage resulting
  // in two equal strings appearing unequal.
  struct RocStr ret = empty_roc_str();

  // Copy the bytes into the stack allocation
  memcpy(&ret, bytes, len);

  write_small_str_len(len, &ret);

  return ret;
}

struct RocStr roc_str_init_large(uint8_t *bytes, size_t len, size_t capacity) {
  // A large RocStr is the same as a List U8 (aka RocBytes) in memory.
  struct RocBytes roc_bytes = init_roc_bytes(bytes, len, capacity);

  struct RocStr ret = {
      .len = roc_bytes.len,
      .bytes = roc_bytes.bytes,
      .capacity = roc_bytes.capacity,
  };

  return ret;
}

bool is_small_str(struct RocStr str) { return ((ssize_t)str.capacity) < 0; }

// Determine the length of the string, taking into
// account the small string optimization
size_t roc_str_len(struct RocStr str) {
  uint8_t *bytes = (uint8_t *)&str;
  uint8_t last_byte = bytes[sizeof(str) - 1];
  uint8_t last_byte_xored = last_byte ^ 0b10000000;
  size_t small_len = (size_t)(last_byte_xored);
  size_t big_len = str.len & PTRDIFF_MAX; // Account for seamless slices

  // Avoid branch misprediction costs by always
  // determining both small_len and big_len,
  // so this compiles to a cmov instruction.
  if (is_small_str(str)) {
    return small_len;
  } else {
    return big_len;
  }
}

size_t roc_str_len_small(struct RocStr str) {
  uint8_t *bytes = (uint8_t *)&str;
  uint8_t last_byte = bytes[sizeof(str) - 1];
  uint8_t last_byte_xored = last_byte ^ 0b10000000;

  return (size_t)(last_byte_xored);
}

size_t roc_str_len_big(struct RocStr str) {
  return str.len & PTRDIFF_MAX; // Account for seamless slices
}

void decref_large_str(struct RocStr str) {
  uint8_t *bytes;

  if ((ssize_t)str.len < 0) {
    // This is a seamless slice, so the bytes are located in the capacity slot.
    bytes = (uint8_t *)(str.capacity << 1);
  } else {
    bytes = str.bytes;
  }

  decref_heap_bytes(bytes, __alignof__(uint8_t));
}

void decref_roc_bytes(struct RocBytes arg) {
  uint8_t *bytes;

  if ((ssize_t)arg.len < 0) {
    // This is a seamless slice, so the bytes are located in the capacity slot.
    bytes = (uint8_t *)(arg.capacity << 1);
  } else {
    bytes = arg.bytes;
  }

  decref_heap_bytes(bytes, __alignof__(uint8_t));
}

// Turn the given Node string into a RocStr and write it into the given RocStr
// pointer.
napi_status node_string_into_roc_str(napi_env env, napi_value node_string,
                                     struct RocStr *roc_str) {
  size_t len;
  napi_status status;

  // Passing NULL for a buffer (and size 0) will make it write the length of the
  // string into `len`.
  // https://nodejs.org/api/n-api.html#napi_get_value_string_utf8
  status = napi_get_value_string_utf8(env, node_string, NULL, 0, &len);

  if (status != napi_ok) {
    return status;
  }

  // Node's "write a string into this buffer" function always writes a null
  // terminator, so capacity will need to be length + 1.
  // https://nodejs.org/api/n-api.html#napi_get_value_string_utf8
  size_t capacity = len + 1;

  // Create a RocStr and write it into the out param
  if (capacity < sizeof(struct RocStr)) {
    // If it can fit in a small string, use the string itself as the buffer.
    // First, zero out those bytes; small strings need to have zeroes for any
    // bytes that are not part of the string, or else comparisons between small
    // strings might fail.
    *roc_str = empty_roc_str();

    // This writes the actual number of bytes copied into len. Theoretically
    // they should be the same, but it could be different if the buffer was
    // somehow smaller. This way we guarantee that the RocStr does not present
    // any memory garbage to the user.
    status = napi_get_value_string_utf8(env, node_string, (char *)roc_str,
                                        sizeof(struct RocStr), &len);

    if (status != napi_ok) {
      return status;
    }

    // We have to write the length into the buffer *after* Node copies its bytes
    // in, because Node will have written a null terminator, which we may need
    // to overwrite.
    write_small_str_len(len, roc_str);
  } else {
    // capacity was too big for a small string, so make a heap allocation and
    // write into that.
    uint8_t *buf = (uint8_t *)roc_alloc(capacity, __alignof__(char));

    // This writes the actual number of bytes copied into len. Theoretically
    // they should be the same, but it could be different if the buffer was
    // somehow smaller. This way we guarantee that the RocStr does not present
    // any memory garbage to the user.
    status = napi_get_value_string_utf8(env, node_string, (char *)buf, capacity,
                                        &len);

    if (status != napi_ok) {
      // Something went wrong, so free the bytes we just allocated before
      // returning.
      roc_dealloc((void *)buf, __alignof__(char *));

      return status;
    }

    *roc_str = roc_str_init_large(buf, len, capacity);
  }

  return status;
}

// Turn the given Node string into a RocBytes and write it into the given
// RocBytes pointer.
napi_status node_string_into_roc_bytes(napi_env env, napi_value node_string,
                                       struct RocBytes *roc_bytes) {
  napi_status status;
  size_t len;

  // Passing NULL for a buffer (and size 0) will make it write the length of the
  // string into `len`.
  // https://nodejs.org/api/n-api.html#napi_get_value_string_utf8
  status = napi_get_value_string_utf8(env, node_string, NULL, 0, &len);

  if (status != napi_ok) {
    return status;
  }

  // Node's "write a string into this buffer" function always writes a null
  // terminator, so capacity will need to be length + 1.
  // https://nodejs.org/api/n-api.html#napi_get_value_string_utf8
  size_t capacity = len + 1;

  // Create a RocBytes and write it into the out param. Make sure we pass
  // an align of a pointer, because roc_alloc calls aligned_alloc, which
  // will not accept alignment values lower than the align of a pointer!
  uint8_t *buf = (uint8_t *)roc_alloc(capacity, __alignof__(uint8_t*));

  // If allocation failed, bail out.
  if (buf == NULL) {
    fprintf(stderr, "WARNING: roc_alloc failed during node_string_into_roc_bytes in nodeJS\n");
    return napi_generic_failure;
  }

  // This writes the actual number of bytes copied into len. Theoretically
  // they should be the same, but it could be different if the buffer was
  // somehow smaller. This way we guarantee that the RocBytes does not present
  // any memory garbage to the user.
  status =
      napi_get_value_string_utf8(env, node_string, (char *)buf, capacity, &len);

  if (status != napi_ok) {
    // Something went wrong, so free the bytes we just allocated before
    // returning.
    roc_dealloc((void *)buf, __alignof__(char *));

    return status;
  }

  *roc_bytes = init_roc_bytes(buf, len, capacity);

  return status;
}

// Consume the given RocStr (decrement its refcount) after creating a Node
// string from it.
napi_value roc_str_into_node_string(napi_env env, struct RocStr roc_str) {
  bool is_small = is_small_str(roc_str);
  char *roc_str_contents;

  if (is_small) {
    // In a small string, the string itself contains its contents.
    roc_str_contents = (char *)&roc_str;
  } else {
    roc_str_contents = (char *)roc_str.bytes;
  }

  napi_value answer;

  if (napi_create_string_utf8(env, roc_str_contents, roc_str_len(roc_str),
                              &answer) != napi_ok) {
    answer = NULL;
  }

  // Decrement the RocStr because we consumed it.
  if (!is_small) {
    decref_large_str(roc_str);
  }

  return answer;
}

// Consume the given RocBytes (decrement its refcount) after creating a Node
// string from it. (Assume we know these are UTF-8 bytes.)
napi_value roc_bytes_into_node_string(napi_env env, struct RocBytes roc_bytes) {
  napi_value answer;

  if (napi_create_string_utf8(env, (char *)roc_bytes.bytes, roc_bytes.len,
                              &answer) != napi_ok) {
    answer = NULL;
  }

  // Decrement the RocStr because we consumed it.
  decref_roc_bytes(roc_bytes);

  return answer;
}

// Create a Node string from the given RocStr.
// Don't decrement the RocStr's refcount. (To decrement it, use
// roc_str_into_node_string instead.)
napi_value roc_str_as_node_string(napi_env env, struct RocStr roc_str) {
  bool is_small = is_small_str(roc_str);
  char *roc_str_contents;

  if (is_small) {
    // In a small string, the string itself contains its contents.
    roc_str_contents = (char *)&roc_str;
  } else {
    roc_str_contents = (char *)roc_str.bytes;
  }

  napi_status status;
  napi_value answer;

  status = napi_create_string_utf8(env, roc_str_contents, roc_str_len(roc_str),
                                   &answer);

  if (status != napi_ok) {
    return NULL;
  }

  // Do not decrement the RocStr's refcount because we did not consume it.

  return answer;
}

// Create a C string from the given RocStr. Don't reuse memory; do a fresh
// malloc for it. Don't decrement the RocStr's refcount. (To decrement it, use
// roc_str_into_c_string instead.)
char *roc_str_into_c_string(struct RocStr roc_str) {
  char *roc_str_contents;
  size_t len;
  bool is_small = is_small_str(roc_str);

  if (is_small) {
    // In a small string, the string itself contains its contents.
    roc_str_contents = (char *)&roc_str;
    len = roc_str_len_small(roc_str);
  } else {
    roc_str_contents = (char *)roc_str.bytes;
    len = roc_str_len_big(roc_str);
  }

  char *buf = (char *)malloc(len + 1); // leave room for the \0 at the end

  // Copy the bytes from the string into the buffer
  memcpy(buf, roc_str_contents, len);

  // Write the \0 at the end
  buf[len] = '\0';

  // Decrement the RocStr because we consumed it.
  if (!is_small) {
    decref_large_str(roc_str);
  }

  return buf;
}

void roc_panic(struct RocStr *roc_str) {
  last_signal = 0;
  last_roc_crash_msg = roc_str_into_c_string(*roc_str);

  longjmp(jump_on_crash, 1);
}

extern void mainForHost(struct RocBytes *ret, struct RocBytes *arg);

napi_value call_mainForHost(napi_env env, napi_callback_info info) {
    // Set the jump point so we can recover from a segfault.
    if (setjmp(jump_on_crash) == 0) {
        // This is *not* the result of a longjmp

        size_t argc = 1;
        napi_value argv[1];
        napi_value arg_buf[1];

        napi_status status = napi_get_cb_info(env, info, &argc, argv, NULL, NULL);

        if (status != napi_ok) {
            return NULL;
        }

        struct RocBytes roc_ret; // This will be populated when the Roc function gets called

        // Call the Roc function to populate `roc_ret`'s bytes.
        struct RocBytes roc_arg; // TODO probably need N of these where N is the arity
        
        if (node_string_into_roc_bytes(env, node_json_string, &roc_arg) != napi_ok) {
            return NULL;
        }

        roc__mainForHost_1_exposed_generic(&roc_ret, &roc_arg); // TODO CALL WITH EXACT ARITY HERE!

        napi_value answer;

        // TODO CONVERT roc_ret INTO THE APPROPRIATE NAPI TYPE FOR answer. WE KNOW WHAT TYPE TO CONVERT IT TO!

        return answer;
    } else {
        // This *is* the result of a longjmp
        char *msg = last_roc_crash_msg != NULL ? (char *)last_roc_crash_msg
                                            : strsignal(last_signal);
        char *suffix =
            " while running `main` in a .roc file";
        char *buf =
            malloc(strlen(msg) + strlen(suffix) + 1); // +1 for the null terminator

        strcpy(buf, msg);
        strcat(buf, suffix);

        napi_throw_error(env, NULL, buf);

        free(buf);

        return NULL;
    }
}

napi_value init(napi_env env, napi_value exports) {
    // Before doing anything else, install signal handlers in case subsequent C
    // code causes any of these.
    struct sigaction action;
    memset(&action, 0, sizeof(action));
    action.sa_handler = signal_handler;

    // Handle all the signals that could take out the Node process and translate
    // them to exceptions.
    sigaction(SIGSEGV, &action, NULL);
    sigaction(SIGBUS, &action, NULL);
    sigaction(SIGFPE, &action, NULL);
    sigaction(SIGILL, &action, NULL);

    // Create our Node functions and expose them from this module.
    napi_status status;
    napi_value fn;

    status = napi_create_function(env, NULL, 0, call_mainForHost, NULL, &fn);

    if (status != napi_ok) {
        return NULL;
    }

    status = napi_set_named_property(env, exports, "callRoc", fn); // TODO when we support multiple entrypoints, rename this from callRoc to e.g. call_mainForHost - but this might result in Node getting call_roc__mainForHost_1 etc. - so might want to clean that up a bit with some find/replace on the underscores

    if (status != napi_ok) {
        return NULL;
    }

    return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)