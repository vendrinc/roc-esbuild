platform "typescript-interop"
    requires {} { main : Str -> Str }
    exposes []
    packages {}
    imports [TotallyNotJson]
    provides [mainForHost]

mainForHost : Str -> List U8
mainForHost = \arg ->
    main arg
    |> Encode.toBytes TotallyNotJson.json
