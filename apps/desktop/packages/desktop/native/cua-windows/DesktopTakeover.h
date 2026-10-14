#pragma once
#include <Windows.h>

namespace fcode::cua {
// Shared physical input is not takeover intent. Only a physical Escape press is.
constexpr bool desktopTakeoverRequested(int code, WPARAM message, DWORD key, DWORD flags,
    ULONG_PTR extraInfo, ULONG_PTR inputTag) {
  return code >= 0 && (message == WM_KEYDOWN || message == WM_SYSKEYDOWN) && key == VK_ESCAPE &&
    !(flags & (LLKHF_INJECTED | LLKHF_LOWER_IL_INJECTED)) && extraInfo != inputTag;
}
}
