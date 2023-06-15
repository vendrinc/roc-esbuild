app "main"
    packages { pf: "platform/main.roc" }
    imports []
    provides [main] to pf

main : Str -> Str
main = \message ->
    "TS said: \(message)! 🎉"
