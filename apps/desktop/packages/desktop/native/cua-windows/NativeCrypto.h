#pragma once
#include "NativeJson.h"
#include <windows.h>
#include <bcrypt.h>
#include <array>
#include <span>
#include <vector>

namespace fcode::cua {
std::string hex(std::span<const uint8_t> bytes);
std::vector<uint8_t> unhex(std::string_view value);
std::string randomHex();
std::string sha256(std::span<const uint8_t> value);
std::string hmac(std::span<const uint8_t> secret, std::string_view payload);
std::string fileHash(std::wstring const& path);
bool constantEqual(std::string_view left, std::string_view right);
}
