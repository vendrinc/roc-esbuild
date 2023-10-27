platform "typescript-interop"
    requires {} { main : { name: Str, foo: Str } -> List U8 }
    exposes []
    packages {}
    imports [TotallyNotJson]
    provides [mainForHost]

mainForHost : { name : Str, foo : Str } -> List U8
mainForHost = \arg ->
    main arg
