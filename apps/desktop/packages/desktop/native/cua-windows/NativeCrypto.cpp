#include "NativeCrypto.h"
#include <fstream>
#include <filesystem>

namespace fcode::cua {
namespace {
class Hash {
public:
  explicit Hash(std::span<const uint8_t> key = {}) {
    require(BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr,
      key.empty() ? 0 : BCRYPT_ALG_HANDLE_HMAC_FLAG) == 0, "backend_unavailable");
    DWORD length = 0, returned = 0;
    auto status = BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH, reinterpret_cast<PUCHAR>(&length), sizeof(length), &returned, 0);
    if (status != 0) { BCryptCloseAlgorithmProvider(algorithm, 0); throw Error("backend_unavailable"); }
    storage.resize(length);
    status = BCryptCreateHash(algorithm, &handle, storage.data(), length, const_cast<PUCHAR>(key.data()), static_cast<ULONG>(key.size()), 0);
    if (status != 0) { BCryptCloseAlgorithmProvider(algorithm, 0); throw Error("backend_unavailable"); }
  }
  ~Hash() { BCryptDestroyHash(handle); BCryptCloseAlgorithmProvider(algorithm, 0); SecureZeroMemory(storage.data(), storage.size()); }
  void update(std::span<const uint8_t> bytes) {
    require(bytes.size() <= ULONG_MAX, "resource_limit");
    require(BCryptHashData(handle, const_cast<PUCHAR>(bytes.data()), static_cast<ULONG>(bytes.size()), 0) == 0, "backend_unavailable");
  }
  std::string finish() {
    std::array<uint8_t, 32> bytes{};
    require(BCryptFinishHash(handle, bytes.data(), static_cast<ULONG>(bytes.size()), 0) == 0, "backend_unavailable");
    return hex(bytes);
  }
  Hash(Hash const&) = delete;
  Hash& operator=(Hash const&) = delete;
private:
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  BCRYPT_HASH_HANDLE handle = nullptr;
  std::vector<uint8_t> storage;
};
}

std::string hex(std::span<const uint8_t> bytes) {
  constexpr char digits[] = "0123456789abcdef";
  std::string result; result.reserve(bytes.size() * 2);
  for (auto byte : bytes) { result += digits[byte >> 4]; result += digits[byte & 15]; }
  return result;
}
std::vector<uint8_t> unhex(std::string_view value) {
  require(value.size() == 64);
  auto nibble = [](char c) -> uint8_t {
    if (c >= '0' && c <= '9') return static_cast<uint8_t>(c - '0');
    if (c >= 'a' && c <= 'f') return static_cast<uint8_t>(c - 'a' + 10);
    throw Error("invalid_request");
  };
  std::vector<uint8_t> bytes; bytes.reserve(32);
  for (size_t index = 0; index < value.size(); index += 2) bytes.push_back(static_cast<uint8_t>((nibble(value[index]) << 4) | nibble(value[index + 1])));
  return bytes;
}
std::string randomHex() {
  std::array<uint8_t, 32> bytes{};
  require(BCryptGenRandom(nullptr, bytes.data(), static_cast<ULONG>(bytes.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG) == 0, "backend_unavailable");
  return hex(bytes);
}
std::string sha256(std::span<const uint8_t> value) { Hash hash; hash.update(value); return hash.finish(); }
std::string hmac(std::span<const uint8_t> secret, std::string_view payload) {
  Hash hash(secret); hash.update({ reinterpret_cast<const uint8_t*>(payload.data()), payload.size() }); return hash.finish();
}
std::string fileHash(std::wstring const& path) {
  std::ifstream file(std::filesystem::path(path), std::ios::binary); require(file.good(), "identity_invalid");
  Hash hash; std::array<uint8_t, 64 * 1024> buffer{};
  while (file.good()) {
    file.read(reinterpret_cast<char*>(buffer.data()), buffer.size());
    auto count = file.gcount(); if (count > 0) hash.update({ buffer.data(), static_cast<size_t>(count) });
  }
  require(file.eof(), "identity_invalid"); return hash.finish();
}
bool constantEqual(std::string_view left, std::string_view right) {
  if (left.size() != right.size()) return false;
  unsigned difference = 0; for (size_t i = 0; i < left.size(); ++i) difference |= static_cast<unsigned char>(left[i] ^ right[i]);
  return difference == 0;
}
}
