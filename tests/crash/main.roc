app "main"
    packages { pf: "platform/main.roc" }
    imports []
    provides [main] to pf

main : Str -> Str
main = \_message ->
    crash "This is an intentional crash!"
