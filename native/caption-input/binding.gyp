{
  "targets": [
    {
      "target_name": "caption_input_native",
      "sources": [ "caption_input_native.cc" ],
      "defines": [
        "NAPI_VERSION=8",
        "WIN32_LEAN_AND_MEAN",
        "NOMINMAX",
        "_WIN32_WINNT=0x0A00"
      ],
      "cflags_cc": [ "/std:c++17", "/EHsc" ],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "ExceptionHandling": 1,
          "DebugInformationFormat": 0
        },
        "VCLinkerTool": {
          "AdditionalOptions": [ "/Brepro", "/DEBUG:NONE" ]
        }
      },
      "libraries": [ "Comctl32.lib", "User32.lib" ],
      "conditions": [
        [ "OS!=\"win\"", {
          "defines": [ "CAPTION_INPUT_UNSUPPORTED_PLATFORM=1" ]
        } ]
      ]
    }
  ]
}
