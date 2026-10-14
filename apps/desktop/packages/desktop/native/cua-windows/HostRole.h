#pragma once
#include <windows.h>
#include <string>

namespace fcode::cua {
void requireHostRole(DWORD pid, HANDLE process, std::wstring const& image);
std::string hostRole();
}
