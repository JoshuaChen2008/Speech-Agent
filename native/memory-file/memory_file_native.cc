#include <node_api.h>
#include <string>
#include <vector>
#include <algorithm>
#include <cwctype>
#ifdef _WIN32
#include <windows.h>
#endif

// SEM-F41: a handle stays exclusive across the SQLite commit. Loaded only in
// the personal-context file worker, never by the caption input addon.
struct File {
#ifdef _WIN32
  HANDLE value = INVALID_HANDLE_VALUE;
  HANDLE directory = INVALID_HANDLE_VALUE;
  HANDLE parent = INVALID_HANDLE_VALUE;
#endif
};
static napi_value Fail(napi_env env, const char* code) {
  napi_throw_error(env, code, code); return nullptr;
}
static void Close(File* f) {
#ifdef _WIN32
  if (f->value != INVALID_HANDLE_VALUE) { CloseHandle(f->value); f->value = INVALID_HANDLE_VALUE; }
  if (f->directory != INVALID_HANDLE_VALUE) { CloseHandle(f->directory); f->directory = INVALID_HANDLE_VALUE; }
  if (f->parent != INVALID_HANDLE_VALUE) { CloseHandle(f->parent); f->parent = INVALID_HANDLE_VALUE; }
#endif
}
static void Finalize(napi_env, void* data, void*) { File* f = static_cast<File*>(data); Close(f); delete f; }
static File* Get(napi_env env, napi_value v) {
  void* data = nullptr;
  if (napi_get_value_external(env, v, &data) != napi_ok || !data) return nullptr;
  return static_cast<File*>(data);
}
#ifdef _WIN32
static std::wstring String(napi_env env, napi_value v) {
  size_t n = 0; if (napi_get_value_string_utf16(env, v, nullptr, 0, &n) != napi_ok) return L"";
  std::vector<char16_t> buf(n + 1);
  if (napi_get_value_string_utf16(env, v, buf.data(), buf.size(), &n) != napi_ok) return L"";
  return std::wstring(reinterpret_cast<wchar_t*>(buf.data()), n);
}
static std::wstring FinalPath(HANDLE h) {
  DWORD n = GetFinalPathNameByHandleW(h, nullptr, 0, FILE_NAME_NORMALIZED);
  if (!n) return L"";
  std::vector<wchar_t> buf(n + 1);
  if (!GetFinalPathNameByHandleW(h, buf.data(), static_cast<DWORD>(buf.size()), FILE_NAME_NORMALIZED)) return L"";
  std::wstring s(buf.data()); std::transform(s.begin(), s.end(), s.begin(), ::towlower); return s;
}
#endif
static napi_value Open(napi_env env, napi_callback_info info) {
  size_t argc = 4; napi_value args[4]; napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
#ifndef _WIN32
  return Fail(env, "MEMORY_FILE_NATIVE_UNAVAILABLE");
#else
  if (argc < 3) return Fail(env, "MEMORY_FILE_INVALID");
  std::wstring path = String(env, args[0]), root = String(env, args[1]); bool create = false;
  if (path.empty() || root.empty() || napi_get_value_bool(env, args[2], &create) != napi_ok) return Fail(env, "MEMORY_FILE_INVALID");
  HANDLE dir = CreateFileW(root.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, nullptr);
  if (dir == INVALID_HANDLE_VALUE) return Fail(env, "MEMORY_FILE_ROOT_UNAVAILABLE");
  std::wstring prefix = FinalPath(dir); if (!prefix.empty() && prefix.back() != L'\\') prefix += L'\\';
  bool writable = true;
  if (argc == 4 && napi_get_value_bool(env, args[3], &writable) != napi_ok) { CloseHandle(dir); return Fail(env, "MEMORY_FILE_INVALID"); }
  if (create && !writable) { CloseHandle(dir); return Fail(env, "MEMORY_FILE_INVALID"); }
  const size_t separator = path.find_last_of(L"\\/");
  if (separator == std::wstring::npos) { CloseHandle(dir); return Fail(env, "MEMORY_FILE_INVALID"); }
  const std::wstring parentPath = path.substr(0, separator);
  HANDLE parent = CreateFileW(parentPath.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  BY_HANDLE_FILE_INFORMATION parentAttributes{};
  const std::wstring actualParent = parent == INVALID_HANDLE_VALUE ? L"" : FinalPath(parent);
  const std::wstring actualRoot = FinalPath(dir);
  if (parent == INVALID_HANDLE_VALUE || !GetFileInformationByHandle(parent, &parentAttributes) ||
      !(parentAttributes.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) || (parentAttributes.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) ||
      (actualParent != actualRoot && (prefix.empty() || actualParent.compare(0, prefix.size(), prefix) != 0))) {
    if (parent != INVALID_HANDLE_VALUE) CloseHandle(parent); CloseHandle(dir); return Fail(env, "MEMORY_FILE_INVALID");
  }
  HANDLE h = CreateFileW(path.c_str(), writable ? GENERIC_READ | GENERIC_WRITE | DELETE : GENERIC_READ, 0, nullptr,
    create ? CREATE_NEW : OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  if (h == INVALID_HANDLE_VALUE) {
    DWORD e = GetLastError(); CloseHandle(parent); CloseHandle(dir);
    return Fail(env, e == ERROR_SHARING_VIOLATION ? "MEMORY_FILE_LOCKED" : e == ERROR_FILE_EXISTS || e == ERROR_ALREADY_EXISTS ? "MEMORY_FILE_CONFLICT" : "MEMORY_FILE_WRITE_FAILED");
  }
  BY_HANDLE_FILE_INFORMATION attributes{};
  std::wstring actual = FinalPath(h);
  bool valid = GetFileInformationByHandle(h, &attributes) && attributes.nNumberOfLinks == 1 &&
    !(attributes.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)) &&
    !prefix.empty() && actual.size() > prefix.size() && actual.compare(0, prefix.size(), prefix) == 0;
  if (!valid) { CloseHandle(h); CloseHandle(parent); CloseHandle(dir); return Fail(env, "MEMORY_FILE_INVALID"); }
  File* f = new File(); f->value = h; f->directory = dir; f->parent = parent; napi_value result;
  napi_create_external(env, f, Finalize, nullptr, &result); return result;
#endif
}
static napi_value Read(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value arg; napi_get_cb_info(env, info, &argc, &arg, nullptr, nullptr);
  File* f = argc == 1 ? Get(env, arg) : nullptr;
#ifndef _WIN32
  return Fail(env, "MEMORY_FILE_NATIVE_UNAVAILABLE");
#else
  if (!f || f->value == INVALID_HANDLE_VALUE) return Fail(env, "MEMORY_FILE_INVALID");
  LARGE_INTEGER size{}, zero{};
  if (!GetFileSizeEx(f->value, &size) || size.QuadPart > 65536 || size.QuadPart < 0) return Fail(env, "MEMORY_FILE_TOO_LARGE");
  if (!SetFilePointerEx(f->value, zero, nullptr, FILE_BEGIN)) return Fail(env, "MEMORY_FILE_READ_FAILED");
  std::vector<unsigned char> bytes(static_cast<size_t>(size.QuadPart)); DWORD read = 0;
  if (!ReadFile(f->value, bytes.data(), static_cast<DWORD>(bytes.size()), &read, nullptr) || read != bytes.size()) return Fail(env, "MEMORY_FILE_READ_FAILED");
  napi_value result; napi_create_buffer_copy(env, bytes.size(), bytes.data(), nullptr, &result); return result;
#endif
}
static napi_value Write(napi_env env, napi_callback_info info) {
  size_t argc = 2; napi_value args[2]; napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  File* f = argc == 2 ? Get(env, args[0]) : nullptr; void* bytes = nullptr; size_t n = 0;
#ifndef _WIN32
  return Fail(env, "MEMORY_FILE_NATIVE_UNAVAILABLE");
#else
  if (!f || f->value == INVALID_HANDLE_VALUE || napi_get_buffer_info(env, args[1], &bytes, &n) != napi_ok || n > 65536) return Fail(env, "MEMORY_FILE_INVALID");
  LARGE_INTEGER zero{}; DWORD written = 0;
  if (!SetFilePointerEx(f->value, zero, nullptr, FILE_BEGIN) || !WriteFile(f->value, bytes, static_cast<DWORD>(n), &written, nullptr) || written != n || !SetEndOfFile(f->value) || !FlushFileBuffers(f->value)) return Fail(env, "MEMORY_FILE_WRITE_FAILED");
  napi_value result; napi_get_boolean(env, true, &result); return result;
#endif
}
static napi_value Release(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value arg; napi_get_cb_info(env, info, &argc, &arg, nullptr, nullptr);
  File* f = argc == 1 ? Get(env, arg) : nullptr;
  if (!f) return Fail(env, "MEMORY_FILE_INVALID"); Close(f);
  napi_value result; napi_get_undefined(env, &result); return result;
}
static napi_value Remove(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value arg; napi_get_cb_info(env, info, &argc, &arg, nullptr, nullptr);
  File* f = argc == 1 ? Get(env, arg) : nullptr;
#ifndef _WIN32
  return Fail(env, "MEMORY_FILE_NATIVE_UNAVAILABLE");
#else
  if (!f || f->value == INVALID_HANDLE_VALUE) return Fail(env, "MEMORY_FILE_INVALID");
  FILE_DISPOSITION_INFO disposition{}; disposition.DeleteFile = TRUE;
  if (!SetFileInformationByHandle(f->value, FileDispositionInfo, &disposition, sizeof(disposition))) return Fail(env, "MEMORY_FILE_WRITE_FAILED");
  Close(f); napi_value result; napi_get_boolean(env, true, &result); return result;
#endif
}
static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor methods[] = {
    {"open", nullptr, Open, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"read", nullptr, Read, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"write", nullptr, Write, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"close", nullptr, Release, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"remove", nullptr, Remove, nullptr, nullptr, nullptr, napi_default, nullptr}
  };
  napi_define_properties(env, exports, 5, methods); return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
