platform "typescript-interop"
    requires {} { main : arg -> ret where arg implements Decoding, ret implements Encoding }
    exposes []
    packages {}
    imports [TotallyNotJson]
    provides [mainForHost]

mainForHost : List U8 -> List U8
mainForHost = \json ->
    when Decode.fromBytes json TotallyNotJson.json is
        Ok arg -> Encode.toBytes (main arg) TotallyNotJson.json
        Err _ -> crash "Roc received malformed JSON from TypeScript"
