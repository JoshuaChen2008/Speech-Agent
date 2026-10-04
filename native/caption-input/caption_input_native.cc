#include <node_api.h>

#include <windows.h>
#include <commctrl.h>

#include <cstdint>
#include <cstring>
#include <cwchar>
#include <exception>
#include <mutex>
#include <unordered_map>
#include <unordered_set>

namespace {

constexpr uint64_t kBindingMagic = 0x43415054554E4954ULL;

struct Binding {
  uint64_t magic = kBindingMagic;
  HWND hwnd = nullptr;
  UINT_PTR subclass_id = 0;
  bool correct = true;
  bool attached = false;
  uint32_t mouse_activate_count = 0;
  uint32_t client_left_down_count = 0;
  uint32_t swallowed_count = 0;
  uint32_t corrected_count = 0;
  int32_t last_result = 0;
};

std::mutex bindings_mutex;
std::unordered_map<HWND, Binding*> bindings;
std::unordered_set<Binding*> live_bindings;

bool get_external(napi_env env, napi_value value, Binding** out) {
  if (out == nullptr) return false;
  *out = nullptr;
  void* data = nullptr;
  if (napi_get_value_external(env, value, &data) != napi_ok || data == nullptr) return false;
  auto* candidate = static_cast<Binding*>(data);
  std::lock_guard<std::mutex> lock(bindings_mutex);
  if (live_bindings.find(candidate) == live_bindings.end() || candidate->magic != kBindingMagic) {
    return false;
  }
  *out = candidate;
  return true;
}

LRESULT CALLBACK CaptionSubclassProc(HWND hwnd, UINT message, WPARAM w_param,
                                     LPARAM l_param, UINT_PTR subclass_id,
                                     DWORD_PTR ref_data) {
  auto* binding = reinterpret_cast<Binding*>(ref_data);
  if (message == WM_NCDESTROY && binding != nullptr) {
    RemoveWindowSubclass(hwnd, CaptionSubclassProc, subclass_id);
    {
      std::lock_guard<std::mutex> lock(bindings_mutex);
      auto found = bindings.find(hwnd);
      if (found != bindings.end() && found->second == binding) bindings.erase(found);
      binding->attached = false;
    }
    return DefSubclassProc(hwnd, message, w_param, l_param);
  }

  LRESULT result = DefSubclassProc(hwnd, message, w_param, l_param);

  if (binding != nullptr && message == WM_MOUSEACTIVATE) {
    binding->mouse_activate_count += 1;
    binding->last_result = static_cast<int32_t>(result);
    const bool client_left_down = LOWORD(l_param) == HTCLIENT &&
      HIWORD(l_param) == WM_LBUTTONDOWN;
    if (client_left_down) binding->client_left_down_count += 1;
    if (result == MA_NOACTIVATEANDEAT) binding->swallowed_count += 1;
    if (binding->correct && client_left_down && result == MA_NOACTIVATEANDEAT) {
      binding->corrected_count += 1;
      result = MA_NOACTIVATE;
    }
  }

  return result;
}

void finalize_binding(napi_env /*env*/, void* data, void* /*hint*/) {
  auto* binding = static_cast<Binding*>(data);
  if (binding == nullptr) return;
  bool attached = false;
  {
    std::lock_guard<std::mutex> lock(bindings_mutex);
    attached = binding->attached;
    binding->attached = false;
    binding->magic = 0;
    live_bindings.erase(binding);
    auto found = bindings.find(binding->hwnd);
    if (found != bindings.end() && found->second == binding) bindings.erase(found);
  }
  if (attached && binding->hwnd != nullptr) {
    RemoveWindowSubclass(binding->hwnd, CaptionSubclassProc, binding->subclass_id);
  }
  delete binding;
}

napi_value make_error(napi_env env, const char* message) {
  napi_throw_error(env, nullptr, message);
  return nullptr;
}

bool read_hwnd(napi_env env, napi_value value, HWND* out) {
  bool is_buffer = false;
  if (napi_is_buffer(env, value, &is_buffer) != napi_ok || !is_buffer) return false;
  void* data = nullptr;
  size_t length = 0;
  if (napi_get_buffer_info(env, value, &data, &length) != napi_ok ||
      data == nullptr || length != sizeof(HWND)) return false;
  uintptr_t raw = 0;
  std::memcpy(&raw, data, sizeof(raw));
  *out = reinterpret_cast<HWND>(raw);
  return *out != nullptr;
}

napi_value attach(napi_env env, napi_callback_info info) {
  napi_value argv[3];
  size_t argc = 3;
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc < 1 || argc > 2) {
    return make_error(env, "caption input attach requires one HWND buffer");
  }
  Binding* binding = nullptr;
  try {
    HWND hwnd = nullptr;
    if (!read_hwnd(env, argv[0], &hwnd) || !IsWindow(hwnd)) {
      return make_error(env, "caption input attach received an invalid HWND");
    }
    DWORD process_id = 0;
    const DWORD window_thread = GetWindowThreadProcessId(hwnd, &process_id);
    if (process_id != GetCurrentProcessId() || window_thread != GetCurrentThreadId()) {
      return make_error(env, "caption input HWND must belong to the current process thread");
    }
    {
      std::lock_guard<std::mutex> lock(bindings_mutex);
      if (bindings.find(hwnd) != bindings.end()) {
        return make_error(env, "caption input HWND is already attached");
      }
    }
    binding = new Binding();
    binding->hwnd = hwnd;
    binding->subclass_id = reinterpret_cast<UINT_PTR>(binding);
    if (argc == 2) {
      bool correct = true;
      if (napi_get_value_bool(env, argv[1], &correct) != napi_ok) {
        delete binding;
        return make_error(env, "caption input attach mode must be boolean");
      }
      binding->correct = correct;
    }
    if (!SetWindowSubclass(hwnd, CaptionSubclassProc, binding->subclass_id,
                           reinterpret_cast<DWORD_PTR>(binding))) {
      delete binding;
      return make_error(env, "caption input SetWindowSubclass failed");
    }
    binding->attached = true;
    {
      std::lock_guard<std::mutex> lock(bindings_mutex);
      bindings.emplace(hwnd, binding);
      live_bindings.emplace(binding);
    }
    napi_value external = nullptr;
    if (napi_create_external(env, binding, finalize_binding, nullptr, &external) != napi_ok) {
      finalize_binding(env, binding, nullptr);
      return make_error(env, "caption input binding allocation failed");
    }
    return external;
  } catch (const std::exception&) {
    if (binding != nullptr) finalize_binding(env, binding, nullptr);
    return make_error(env, "caption input native binding failed");
  } catch (...) {
    if (binding != nullptr) finalize_binding(env, binding, nullptr);
    return make_error(env, "caption input native binding failed");
  }
}

napi_value is_attached(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  size_t argc = 1;
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1) {
    return make_error(env, "caption input isAttached requires a binding");
  }
  Binding* binding = nullptr;
  if (!get_external(env, argv[0], &binding)) return make_error(env, "invalid caption input binding");
  napi_value result = nullptr;
  if (napi_get_boolean(env, binding->attached, &result) != napi_ok) return nullptr;
  return result;
}

napi_value detach(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  size_t argc = 1;
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1) {
    return make_error(env, "caption input detach requires a binding");
  }
  Binding* binding = nullptr;
  if (!get_external(env, argv[0], &binding)) return make_error(env, "invalid caption input binding");
  if (binding->attached && binding->hwnd != nullptr) {
    RemoveWindowSubclass(binding->hwnd, CaptionSubclassProc, binding->subclass_id);
    binding->attached = false;
    std::lock_guard<std::mutex> lock(bindings_mutex);
    auto found = bindings.find(binding->hwnd);
    if (found != bindings.end() && found->second == binding) bindings.erase(found);
  }
  napi_value result = nullptr;
  napi_get_undefined(env, &result);
  return result;
}

napi_value get_stats(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  size_t argc = 1;
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1) {
    return make_error(env, "caption input getStats requires a binding");
  }
  Binding* binding = nullptr;
  if (!get_external(env, argv[0], &binding)) return make_error(env, "invalid caption input binding");
  napi_value result = nullptr;
  napi_create_object(env, &result);
  napi_value value = nullptr;
  napi_create_uint32(env, binding->mouse_activate_count, &value);
  napi_set_named_property(env, result, "mouseActivateCount", value);
  napi_create_uint32(env, binding->client_left_down_count, &value);
  napi_set_named_property(env, result, "clientLeftDownCount", value);
  napi_create_uint32(env, binding->swallowed_count, &value);
  napi_set_named_property(env, result, "swallowedCount", value);
  napi_create_uint32(env, binding->corrected_count, &value);
  napi_set_named_property(env, result, "correctedCount", value);
  napi_create_int32(env, binding->last_result, &value);
  napi_set_named_property(env, result, "lastResult", value);
  napi_get_boolean(env, binding->correct, &value);
  napi_set_named_property(env, result, "correct", value);
  return result;
}

napi_value normalize_mouse_activate(napi_env env, napi_callback_info info) {
  napi_value argv[3];
  size_t argc = 3;
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 3) {
    return make_error(env, "normalizeMouseActivate requires result, hit test and message");
  }
  int32_t result = 0;
  int32_t hit_test = 0;
  int32_t mouse_message = 0;
  if (napi_get_value_int32(env, argv[0], &result) != napi_ok ||
      napi_get_value_int32(env, argv[1], &hit_test) != napi_ok ||
      napi_get_value_int32(env, argv[2], &mouse_message) != napi_ok) {
    return make_error(env, "normalizeMouseActivate arguments must be integers");
  }
  if (result == MA_NOACTIVATEANDEAT && hit_test == HTCLIENT &&
      mouse_message == WM_LBUTTONDOWN) result = MA_NOACTIVATE;
  napi_value output = nullptr;
  if (napi_create_int32(env, result, &output) != napi_ok) return nullptr;
  return output;
}

napi_value inspect_window(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  size_t argc = 1;
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1) {
    return make_error(env, "inspectWindow requires an HWND buffer");
  }
  HWND hwnd = nullptr;
  if (!read_hwnd(env, argv[0], &hwnd) || !IsWindow(hwnd)) {
    return make_error(env, "inspectWindow received an invalid HWND");
  }
  DWORD process_id = 0;
  const DWORD thread_id = GetWindowThreadProcessId(hwnd, &process_id);
  napi_value result = nullptr;
  napi_create_object(env, &result);
  napi_value value = nullptr;
  napi_get_boolean(env, process_id == GetCurrentProcessId(), &value);
  napi_set_named_property(env, result, "sameProcess", value);
  napi_get_boolean(env, thread_id == GetCurrentThreadId(), &value);
  napi_set_named_property(env, result, "sameThread", value);
  napi_get_boolean(env, (GetWindowLongPtrW(hwnd, GWL_EXSTYLE) & WS_EX_NOACTIVATE) != 0, &value);
  napi_set_named_property(env, result, "noActivateStyle", value);
  napi_get_boolean(env, (GetWindowLongPtrW(hwnd, GWL_EXSTYLE) & WS_EX_TRANSPARENT) != 0, &value);
  napi_set_named_property(env, result, "transparentStyle", value);
  return result;
}

napi_value probe_mouse_activate(napi_env env, napi_callback_info info) {
  napi_value argv[3];
  size_t argc = 3;
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 3) {
    return make_error(env, "probeMouseActivate requires a binding, hit test and message");
  }
  Binding* binding = nullptr;
  if (!get_external(env, argv[0], &binding) || binding == nullptr ||
      !binding->attached || binding->hwnd == nullptr || !IsWindow(binding->hwnd)) {
    return make_error(env, "probeMouseActivate received an inactive binding");
  }
  int32_t hit_test = 0;
  int32_t mouse_message = 0;
  if (napi_get_value_int32(env, argv[1], &hit_test) != napi_ok ||
      napi_get_value_int32(env, argv[2], &mouse_message) != napi_ok) {
    return make_error(env, "probeMouseActivate hit test and message must be integers");
  }
  const LPARAM packed = static_cast<LPARAM>(
    (static_cast<uintptr_t>(static_cast<uint16_t>(mouse_message)) << 16) |
    static_cast<uint16_t>(hit_test));
  const LRESULT result = SendMessageW(binding->hwnd, WM_MOUSEACTIVATE, 0, packed);
  napi_value output = nullptr;
  if (napi_create_int32(env, static_cast<int32_t>(result), &output) != napi_ok) return nullptr;
  return output;
}

napi_value read_shortcut_keys(napi_env env, napi_callback_info info) {
  // Read only the current high bit. The low 'pressed since last call' bit is
  // shared with other processes and is not a reliable edge detector.
  HDESK input_desktop = OpenInputDesktop(0, FALSE, DESKTOP_READOBJECTS);
  if (input_desktop == nullptr) return make_error(env, "shortcut input desktop is unavailable");
  wchar_t active_name[256] = {}, thread_name[256] = {};
  DWORD needed = 0;
  const bool readable = GetUserObjectInformationW(input_desktop, UOI_NAME, active_name, sizeof(active_name), &needed) &&
      GetUserObjectInformationW(GetThreadDesktop(GetCurrentThreadId()), UOI_NAME, thread_name, sizeof(thread_name), &needed) &&
      wcscmp(active_name, thread_name) == 0;
  CloseDesktop(input_desktop);
  if (!readable) return make_error(env, "shortcut input desktop is unavailable");
  napi_value result = nullptr;
  if (napi_create_array(env, &result) != napi_ok) return nullptr;
  uint32_t count = 0;
  for (int vk = 1; vk < 255; ++vk) {
    // Generic modifier aliases would duplicate the physical left/right keys.
    if (vk == VK_SHIFT || vk == VK_CONTROL || vk == VK_MENU) continue;
    if ((GetAsyncKeyState(vk) & 0x8000) == 0) continue;
    napi_value value = nullptr;
    if (napi_create_int32(env, vk, &value) != napi_ok || napi_set_element(env, result, count++, value) != napi_ok) return nullptr;
  }
  return result;
}

napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {"attach", nullptr, attach, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"isAttached", nullptr, is_attached, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"detach", nullptr, detach, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"readShortcutKeys", nullptr, read_shortcut_keys, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"getStats", nullptr, get_stats, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"normalizeMouseActivate", nullptr, normalize_mouse_activate, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"inspectWindow", nullptr, inspect_window, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"probeMouseActivate", nullptr, probe_mouse_activate, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  if (napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties) != napi_ok) {
    return nullptr;
  }
  return exports;
}

}  // namespace

NAPI_MODULE_INIT() { return init(env, exports); }
