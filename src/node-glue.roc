app "node-glue"
    packages { pf: "../vendor/glue-platform/main.roc" }
    imports [
        pf.Types.{ Types },
        pf.File.{ File },
        GlueDTS,
        GlueC,
    ]
    provides [makeGlue] to pf

makeGlue : List Types -> Result (List File) Str
makeGlue = \typesByArch ->
    Ok [
        {
            # TODO get the input filename and make the output .d.ts file be based on that
            name: "main.roc.d.ts",
            content: GlueDTS.generate typesByArch,
        },
        {
            # TODO get the input filename and make the output .c file be based on that
            name: "node-to-roc.c",
            content: GlueC.generate typesByArch,
        },
    ]
