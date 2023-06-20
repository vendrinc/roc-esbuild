platform "typescript-interop"
    requires {} { main : arg -> ret | arg has Decoding, ret has Encoding }
    exposes []
    packages {}
    imports []
    provides [mainForHost]

mainForHost : List U8 -> List U8
mainForHost = \json ->
    when Decode.fromBytes json Json.json is
        Ok arg -> Encode.toBytes (main arg) Json.json
        Err _ -> [] # crash "Roc received malformed JSON from TypeScript"
