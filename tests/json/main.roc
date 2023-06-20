app "main"
    packages { pf: "platform.roc" }
    imports []
    provides [main] to pf

main : { firstName : Str, lastName : Str } -> Str
main = \{ firstName, lastName } ->
    "TS says your first name is \(firstName) and your last name is \(lastName)! 🎉"
