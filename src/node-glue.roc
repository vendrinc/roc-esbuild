app "node-glue"
    packages { pf: "../vendor/glue-platform/main.roc" }
    imports [pf.Types.{ Types }, pf.File.{ File }, "node-to-roc.c" as content : Str]
    provides [makeGlue] to pf

makeGlue : List Types -> Result (List File) Str
makeGlue = \_typesByArch ->
    Ok []
