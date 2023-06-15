platform "typescript-interop"
    requires {} { main : arg -> ret | arg has Decode, ret has Encode }
    exposes []
    packages {}
    imports [Json]
    provides [mainForHost]

mainForHost : List U8 -> List U8
mainForHost = \input ->
    input
    |> Decode.fromBytes Json.json
    |> main
    |> Encode.toBytes Json.json
