interface GlueC
    exposes [generate]
    imports [
        pf.Types.{ Types },
        # pf.Shape.{ Shape }, # , RocStructFields },
        pf.TypeId.{ TypeId },
        "header.c" as header : Str,
    ]

generate : List Types -> Str
generate = \typesByArch ->
    List.walk typesByArch header \buf, types ->
        arch = (Types.target types).architecture

        # Always use aarch64 for now. TODO generate a different .c file for each architecture,
        # and then #include the correct one depending on the architecture we're currently targeting!
        if arch == Aarch64 then
            buf
            |> addEntryPoints types
        else
            buf

addEntryPoints : Str, Types -> Str
addEntryPoints = \buf, types ->
    List.walk (Types.entryPoints types) buf \state, T name id ->
        addEntryPoint state types name id

    |> Str.concat (init types)

getPopulateArgs : Types, List TypeId -> { populate: Str, argsForCall: List Str, argTypes: List Str, arity: Nat }
getPopulateArgs = \types, args ->
    initialState = { populate: "", argsForCall: [], argTypes: [], arity: 0 }

    List.walkWithIndex args initialState \state, typeId, index ->
        shape = Types.shape types typeId
        indexStr = Num.toStr index
        src = "argv[\(indexStr)]"
        dest = "roc_arg_\(indexStr)"

        (decl, call, ifOk) =
            when shape is
                RocStr -> ("struct RocStr", "node_string_into_roc_str(env, \(src), &\(dest))", "")
                Bool -> ("bool", "napi_get_value_bool(env, \(src), &\(dest))", "")
                Num F64 -> ("double", "napi_get_value_double(env, \(src), &\(dest))", "")
                Num F32 -> ("float", "node_double_into_float(env, \(src), &\(dest))", "")
                Num U8 -> ("double tmp; uint8_t", "node_double_into_bounded_int(env, \(src), &tmp, 0, UINT8_MAX)", "\(dest) = (uint8_t)tmp;") # For debugging: printf(\"Result: %u\\n\", \(dest));
                Num I8 -> ("double tmp; int8_t", "node_double_into_bounded_int(env, \(src), &tmp, INT8_MIN, INT8_MAX)", "\(dest) = (int8_t)tmp;")
                Num U16 -> ("double tmp; uint16_t", "node_double_into_bounded_int(env, \(src), &tmp, 0, UINT16_MAX)", "\(dest) = (uint16_t)tmp;")
                Num I16 -> ("double tmp; int16_t", "node_double_into_bounded_int(env, \(src), &tmp, INT16_MIN, INT16_MAX)", "\(dest) = (int16_t)tmp;")
                Num U32 -> ("double tmp; uint32_t", "node_double_into_bounded_int(env, \(src), &tmp, 0, UINT32_MAX)", "\(dest) = (uint32_t)tmp;")
                Num I32 -> ("double tmp; int32_t", "node_double_into_bounded_int(env, \(src), &tmp, INT32_MIN, INT32_MAX)", "\(dest) = (int32_t)tmp;")
                Num U64 -> crash "TODO use napi_get_value_int64 and cast it from int64_t to uint32_t (this will definitely all succeed!)"
                Num I64 -> crash "TODO use napi_get_value_int64 and cast it from int64_t to uint32_t (this will definitely all succeed!)"
                Num U128 -> crash "TODO use napi_get_value_bigint_words and verify that it is in the U128 range; otherwise throw an exception."
                Num I128 -> crash "TODO use napi_get_value_bigint_words and verify that it is in the I128 range; otherwise throw an exception."
                _ -> crash "TODO support remaining arg shapes, including \(Inspect.toStr shape)"

        {
            populate:
                """
                \(state.populate)
                        \(decl) \(dest);
                        if (\(call) != napi_ok) { return NULL; }
                        \(ifOk)
                """,
            argsForCall: List.append state.argsForCall "&\(dest)",
            argTypes: List.append state.argTypes "\(rocTypeName types typeId)*",
            arity: state.arity + 1,
        }

getPopulateAnswer : Types, TypeId -> Str
getPopulateAnswer = \types, typeId ->
    when Types.shape types typeId is
        RocStr -> "answer = roc_str_into_node_string(env, roc_ret);"
        _ -> crash "TODO support remaining ret shapes"

addEntryPoint : Str, Types, Str, TypeId -> Str
addEntryPoint = \buf, types, name, id ->
    (retTypeId, { populate: populateArgs, argsForCall, argTypes, arity }) =
        when Types.shape types id is
            Function fn -> (fn.ret, getPopulateArgs types fn.args)
            _ -> (id, { populate: "", argsForCall: [], argTypes: [], arity: 0 })

    arityStr = Num.toStr arity
    rocRetType = rocTypeName types retTypeId
    externName = "roc__\(name)_1_exposed_generic"

    # crash "TODO need to forward-declare structs for record types etc, also use C type names rather than d.ts type names."
    body =
        """
        \(buf)
        extern void \(externName)(struct RocStr *ret, \(argTypes |> Str.joinWith ", "));

        napi_value call_\(name)(napi_env env, napi_callback_info info) {
            // Set the jump point so we can recover from a segfault.
            if (setjmp(jump_on_crash) == 0) {
                // This is *not* the result of a longjmp

                size_t argc = \(arityStr);
                napi_value argv[\(arityStr)];

                napi_status status = napi_get_cb_info(env, info, &argc, argv, NULL, NULL);

                if (status != napi_ok) {
                    return NULL;
                }

                \(rocRetType) roc_ret; // This will be populated when the Roc function gets called

                // Populate the arguments we'll pass to the roc function
                \(populateArgs)
                // Call the Roc function to populate `roc_ret`'s bytes.
                \(externName)(\(argsForCall |> List.prepend "&roc_ret" |> Str.joinWith ", "));

                napi_value answer;

                \(getPopulateAnswer types retTypeId)

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

        """

    body

# TODO generate this
init : Types -> Str
init = \types ->
    nodeFns = # TODO dynamically generate these from Types
        List.walk (Types.entryPoints types) "" \_state, T name _ ->
            """

                status = napi_create_function(env, NULL, 0, call_\(name), NULL, &fn);

                if (status != napi_ok) {
                    return NULL;
                }

                status = napi_set_named_property(env, exports, "callRoc", fn); // TODO when we support multiple entrypoints, rename this from callRoc to e.g. call_\(name) - but this might result in Node getting call_roc__mainForHost_1 etc. - so might want to clean that up a bit with some find/replace on the underscores

                if (status != napi_ok) {
                    return NULL;
                }
            """

    """

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
    \(nodeFns)

        return exports;
    }

    NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
    """

rocTypeName : Types, TypeId -> Str
rocTypeName = \types, id ->
    when Types.shape types id is
        Bool -> "bool"
        RocStr -> "struct RocStr"
        Num num -> rocNumTypeName num
        Unit -> "struct Unit"
        Unsized -> "void *" # opaque list of bytes (List<U8> in Roc)
        EmptyTagUnion -> "struct Never"
        RocList elemTypeId -> "RocList<\(rocTypeName types elemTypeId)>"
        RocDict key value -> "Map<\(rocTypeName types key), \(rocTypeName types value)>"
        RocSet elem -> "Set<\(rocTypeName types elem)>"
        RocBox _elem -> crash "TODO generate types for RocBox"
        RocResult _ok _err -> crash "TODO generate types for RocResult"
        RecursivePointer content -> rocTypeName types content
        Struct { fields } ->
            when fields is
                HasNoClosure list -> recordTypeName types list
                HasClosure list -> recordTypeName types list

        TagUnionPayload { name } -> escapeKW name
        TagUnion (NonRecursive { name }) -> escapeKW name
        TagUnion (Recursive { name }) -> escapeKW name
        TagUnion (Enumeration { name }) -> escapeKW name
        TagUnion (NullableWrapped { name }) -> escapeKW name
        TagUnion (NullableUnwrapped { name }) -> escapeKW name
        TagUnion (NonNullableUnwrapped { name }) -> escapeKW name
        TagUnion (SingleTagStruct { name }) -> escapeKW name
        Function { functionName } -> escapeKW functionName

rocNumTypeName = \num ->
    when num is
        U8 -> "uint8_t"
        I8 -> "int8_t"
        U16 -> "uint16_t"
        I16 -> "int16_t"
        U32 -> "uint32_t"
        I32 -> "int32_t"
        F32 -> "float"
        F64 -> "double"
        U64 -> "uint64_t"
        I64 -> "int64_t"
        U128 -> "unsigned __int128"
        I128 -> "__int128"
        Dec -> crash "TODO convert from Roc Dec to a C wrapper around RocDec"

escapeKW : Str -> Str
escapeKW = \input ->
    if Set.contains reservedKeywords input then
        "roc_\(input)"
    else
        input

reservedKeywords : Set Str
reservedKeywords = Set.fromList [
    "break",
    "case",
    "catch",
    "class",
    "const",
    "continue",
    "debugger",
    "default",
    "delete",
    "do",
    "else",
    "export",
    "extends",
    "finally",
    "for",
    "function",
    "if",
    "import",
    "in",
    "instanceof",
    "let",
    "new",
    "return",
    "super",
    "switch",
    "this",
    "throw",
    "try",
    "typeof",
    "var",
    "void",
    "while",
    "with",
    "yield",
    "implements",
    "interface",
    "package",
    "private",
    "protected",
    "public",
    "static",
    "async",
    "await",
    "get",
    "set",
    "of",
    "enum",
    "as",
    "from",
    "null",
    "true",
    "false",
]

# toArgStr : List TypeId, Types, (TypeId, Shape, Nat -> Str) -> Str
# toArgStr = \args, types, fmt ->
#     List.walkWithIndex args "" \state, argId, index ->
#         shape = Types.shape types argId

#         # Drop `{}` args, as JavaScript has no equivalent of passing {}; instead, they would just not accept anything.
#         if isUnit shape then
#             state
#         else
#             argStr = fmt argId shape index

#             if Str.isEmpty state then
#                 argStr # Don't prepend a comma if this is the first one
#             else
#                 state
#                 |> Str.concat ", "
#                 |> Str.concat argStr

recordTypeName : Types, List { name : Str, id : TypeId }* -> Str
recordTypeName = \types, fields ->
    fieldTypes =
        fields
        |> List.map \{name, id} -> "\(name): \(rocTypeName types id)"
        |> Str.joinWith ", "

    "{ \(fieldTypes) }"

# isUnit : Shape -> Bool
# isUnit = \shape ->
#     when shape is
#         Unit -> Bool.true
#         _ -> Bool.false

## nodeTypeName must be one of:
##     uint32
##     int32
##     int64
##     double
##     bigint_int64
##     bigint_uint64
##
## Node doesn't have any other functions to create those.
##
## For 128-bit numbers, use https://nodejs.org/api/n-api.html#napi_create_bigint_words
# rocNumToNode : Str, Str, Str -> Str
# rocNumToNode = \nodeTypeName, inputName, outputName ->
#     """
#         status = napi_create_\(nodeTypeName)(env, \(inputName), \(outputName));
#     """

## nodeTypeName must be one of:
##     string_utf8
##     bool
##     int32
##     int64
##     double
##     external (gives a void*)
##
## Node doesn't have any other functions to create those.
# nodeScalarToRoc : Str, Str, Str -> Str
# nodeScalarToRoc = \nodeTypeName, inputName, outputName ->
#     """
#         status = napi_get_value_\(nodeTypeName)(env, \(inputName), \(outputName));
#     """

## nodeTypeName must be one of:
##     bigint_int64
##     bigint_uint64
##     bigint_words
##
## Node doesn't have any other functions to create those.
# nodeBigIntToRoc : Str, Str, Str -> Str
# nodeBigIntToRoc = \nodeTypeName, inputName, outputName ->
#     """
#         status = napi_get_value_\(nodeTypeName)(env, \(inputName), \(outputName), &lossless);
#     """
