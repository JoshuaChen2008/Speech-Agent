{
  "targets": [{
    "target_name": "memory_file_native",
    "sources": ["memory_file_native.cc"],
    "defines": ["NAPI_VERSION=8", "WIN32_LEAN_AND_MEAN", "NOMINMAX"],
    "msvs_settings": {"VCCLCompilerTool": {"ExceptionHandling": 1, "AdditionalOptions": ["/std:c++17"]}},
    "conditions": [["OS!='win'", {"defines": ["MEMORY_FILE_UNSUPPORTED=1"]}]]
  }]
}
