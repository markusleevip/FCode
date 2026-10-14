#include <windows.h>
#include <sddl.h>
#include <shlobj.h>
#ifdef GetObject
#undef GetObject
#endif
#include "DesktopLease.h"
#include "NativeCrypto.h"
#include "HostPolicy.h"
#include <array>
#include <filesystem>

namespace fcode::cua {
namespace {
constexpr std::array<uint8_t, 8> Magic{'F', 'C', 'o', 'd', 'e', 'C', 'U', '1'};
constexpr size_t JournalBytes = 16;
void directory(std::filesystem::path const& path, SECURITY_ATTRIBUTES* security = nullptr) {
  if (!CreateDirectoryW(path.c_str(), security)) require(GetLastError() == ERROR_ALREADY_EXISTS, "backend_unavailable");
  auto attributes = GetFileAttributesW(path.c_str());
  require(attributes != INVALID_FILE_ATTRIBUTES && (attributes & FILE_ATTRIBUTE_DIRECTORY) &&
    !(attributes & FILE_ATTRIBUTE_REPARSE_POINT), "identity_invalid");
}
struct Descriptor {
  PSECURITY_DESCRIPTOR value = nullptr;
  ~Descriptor() { if (value) LocalFree(value); }
};
}
void DesktopLease::acquire(std::wstring const& logonSid) {
  if (owned()) return;
  PWSTR raw = nullptr;
  require(SUCCEEDED(SHGetKnownFolderPath(FOLDERID_LocalAppData, KF_FLAG_DEFAULT, nullptr, &raw)), "backend_unavailable");
  std::filesystem::path root(raw); CoTaskMemFree(raw);
  auto attributes = GetFileAttributesW(root.c_str());
  require(attributes != INVALID_FILE_ATTRIBUTES && !(attributes & FILE_ATTRIBUTE_REPARSE_POINT), "identity_invalid");
  for (auto const& component : {L"FCode", L"ComputerUse", L"WindowsLease"}) { root /= component; directory(root); }
  auto identity = winrt::to_string(logonSid) + ":" FCODE_LEASE_TEST_SCOPE;
  root /= wide(sha256({reinterpret_cast<uint8_t const*>(identity.data()), identity.size()})).c_str();
  Descriptor descriptor;
  auto text = L"D:P(A;;GA;;;" + logonSid + L")";
  require(ConvertStringSecurityDescriptorToSecurityDescriptorW(text.c_str(), SDDL_REVISION_1, &descriptor.value, nullptr), "identity_invalid");
  SECURITY_ATTRIBUTES security{sizeof(SECURITY_ATTRIBUTES), descriptor.value, FALSE};
  directory(root, &security);
  auto path = root / L"control.journal";
  constexpr DWORD Flags = FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_WRITE_THROUGH;
  HANDLE rawFile = CreateFileW(path.c_str(), GENERIC_READ | GENERIC_WRITE, 0, &security, CREATE_NEW, Flags, nullptr);
  bool created = rawFile != INVALID_HANDLE_VALUE;
  if (!created) {
    auto error = GetLastError();
    require(error == ERROR_FILE_EXISTS || error == ERROR_ALREADY_EXISTS, error == ERROR_SHARING_VIOLATION ? "control_busy" : "backend_unavailable");
    rawFile = CreateFileW(path.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, Flags, nullptr);
    if (rawFile == INVALID_HANDLE_VALUE) throw Error(GetLastError() == ERROR_SHARING_VIOLATION ? "control_busy" : "backend_unavailable");
  }
  auto candidate = std::make_unique<Handle>(rawFile);
  FILE_ATTRIBUTE_TAG_INFO tag{};
  require(GetFileInformationByHandleEx(rawFile, FileAttributeTagInfo, &tag, sizeof(tag)) &&
    !(tag.FileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)), "identity_invalid");
  LARGE_INTEGER size{};
  require(GetFileSizeEx(rawFile, &size), "backend_unavailable");
  if (!created) {
    require(size.QuadPart == JournalBytes, "execution_uncertain");
    std::array<uint8_t, JournalBytes> bytes{}; DWORD read = 0;
    require(ReadFile(rawFile, bytes.data(), static_cast<DWORD>(bytes.size()), &read, nullptr) && read == bytes.size(), "execution_uncertain");
    require(std::equal(Magic.begin(), Magic.end(), bytes.begin()) &&
      std::all_of(bytes.begin() + Magic.size(), bytes.end(), [](auto byte) { return byte == 0; }), "execution_uncertain");
  }
  journal = std::move(candidate);
  if (created) write(false);
}
void DesktopLease::write(bool pending) {
  require(owned(), "not_authorized");
  std::array<uint8_t, JournalBytes> bytes{};
  std::copy(Magic.begin(), Magic.end(), bytes.begin()); bytes[Magic.size()] = pending ? 1 : 0;
  LARGE_INTEGER start{}; DWORD written = 0;
  require(SetFilePointerEx(journal->get(), start, nullptr, FILE_BEGIN) &&
    WriteFile(journal->get(), bytes.data(), static_cast<DWORD>(bytes.size()), &written, nullptr) && written == bytes.size() &&
    FlushFileBuffers(journal->get()), "execution_uncertain");
}
void DesktopLease::beginInput() { write(true); }
void DesktopLease::confirmInput() { write(false); }
}
