interface GlueDTS
    exposes [generate]
    imports [
        pf.Types.{ Types },
        pf.Shape.{ Shape }, # , RocStructFields },
        pf.TypeId.{ TypeId },
        "header.d.ts" as header : Str,
    ]

generate : List Types -> Str
generate = \typesByArch ->
    List.walk typesByArch header \buf, types ->
        arch = (Types.target types).architecture

        # Always use aarch64 for now, and ignore the others.
        # This is because we only want to generate one .d.ts
        # file (not a different one per architecture), and
        # we want it to use 64-bit assumptions (specifically, `Nat`
        # becomes `bignum` instead of `number`) becuase those
        # assumptions will match what happens when `Nat` becomes `U64`.
        if arch == Aarch64 then
            buf
            |> addEntryPoints types
        else
            buf

addEntryPoints : Str, Types -> Str
addEntryPoints = \buf, types ->
    List.walk (Types.entryPoints types) buf \state, T name id ->
        addEntryPoint state types name id

addEntryPoint : Str, Types, Str, TypeId -> Str
addEntryPoint = \buf, types, name, id ->
    signature =
        when Types.shape types id is
            Function rocFn ->
                arguments =
                    toArgStr rocFn.args types \argId, _shape, index ->
                        "arg\(Num.toStr index): \(typeName types argId)"

                "(\(arguments)): \(typeName types rocFn.ret)"

            _ ->
                "(): \(typeName types id)"

    "\(buf)\nexport function \(name)\(signature);\n"

typeName : Types, TypeId -> Str
typeName = \types, id ->
    when Types.shape types id is
        Bool -> "boolean"
        RocStr -> "string"
        Num U8 | Num I8 | Num U16 | Num I16 | Num U32 | Num I32 | Num F32 | Num F64 -> "number"
        Num U64 | Num I64 | Num U128 | Num I128 -> "BigInt"
        Num Dec -> crash "TODO convert from Roc Dec to some JavaScript type (possibly a C wrapper around RocDec?)"
        # Arguably Unit should be `void` in some contexts (e.g. Promises and return types),
        # but then again, why would you ever have a Roc function that returns {}? Perhaps more
        # relevantly, a Roc function that accepts {} as its argument should accept 0 arguments in TS.
        # For now, this works because if you pass nothing, it will be like passing undefined.
        Unit -> "undefined"
        Unsized -> "Uint8Array" # opaque list of bytes (List<U8> in Roc)
        EmptyTagUnion -> "never"
        RocList elemTypeId ->
            when Types.shape types elemTypeId is
                Num U8 -> "Uint8Array"
                Num I8 -> "Int8Array"
                Num U16 -> "Uint16Array"
                Num I16 -> "Int16Array"
                Num U32 -> "Uint32Array"
                Num I32 -> "Int32Array"
                Num U64 -> "BigUint64Array"
                Num I64 -> "BigInt64Array"
                Num F32 -> "Float32Array"
                Num F64 -> "Float64Array"
                _ -> "Array<\(typeName types elemTypeId)>"

        RocDict key value -> "Map<\(typeName types key), \(typeName types value)>"
        RocSet elem -> "Set<\(typeName types elem)>"
        RocBox _elem -> crash "TODO generate types for RocBox"
        RocResult _ok _err -> crash "TODO generate types for RocResult"
        RecursivePointer content -> typeName types content
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

toArgStr : List TypeId, Types, (TypeId, Shape, Nat -> Str) -> Str
toArgStr = \args, types, fmt ->
    List.walkWithIndex args "" \state, argId, index ->
        shape = Types.shape types argId

        # Drop `{}` args, as JavaScript has no equivalent of passing {}; instead, they would just not accept anything.
        if isUnit shape then
            state
        else
            argStr = fmt argId shape index

            if Str.isEmpty state then
                argStr # Don't prepend a comma if this is the first one
            else
                state
                |> Str.concat ", "
                |> Str.concat argStr

recordTypeName : Types, List { name : Str, id : TypeId }* -> Str
recordTypeName = \types, fields ->
    fieldTypes =
        fields
        |> List.map \{name, id} -> "\(name): \(typeName types id)"
        |> Str.joinWith ", "

    "{ \(fieldTypes) }"

isUnit : Shape -> Bool
isUnit = \shape ->
    when shape is
        Unit -> Bool.true
        _ -> Bool.false
