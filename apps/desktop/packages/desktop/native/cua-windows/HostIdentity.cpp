#include "HostIdentity.h"
#include "NativeCrypto.h"
#include "HostPolicy.h"
#include "HostRole.h"
#include <tlhelp32.h>
#include <sddl.h>
#include <winternl.h>

namespace fcode::cua {
namespace {
DWORD actualParent() {
  Handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
  require(snapshot.get() != INVALID_HANDLE_VALUE, "identity_invalid");
  PROCESSENTRY32W entry{}; entry.dwSize = sizeof(entry);
  if (Process32FirstW(snapshot.get(), &entry)) do {
    if (entry.th32ProcessID == GetCurrentProcessId()) return entry.th32ParentProcessID;
  } while (Process32NextW(snapshot.get(), &entry));
  throw Error("identity_invalid");
}
std::vector<uint8_t> tokenInformation(HANDLE process, TOKEN_INFORMATION_CLASS kind) {
  HANDLE raw = nullptr; require(OpenProcessToken(process, TOKEN_QUERY, &raw) != FALSE, "identity_invalid");
  Handle token(raw); DWORD length = 0;
  GetTokenInformation(token.get(), kind, nullptr, 0, &length); require(length > 0 && length < 64 * 1024, "identity_invalid");
  std::vector<uint8_t> bytes(length);
  require(GetTokenInformation(token.get(), kind, bytes.data(), length, &length) != FALSE, "identity_invalid"); return bytes;
}
bool sameUser(HANDLE left, HANDLE right) {
  auto leftUser = tokenInformation(left, TokenUser), rightUser = tokenInformation(right, TokenUser);
  return EqualSid(reinterpret_cast<TOKEN_USER*>(leftUser.data())->User.Sid, reinterpret_cast<TOKEN_USER*>(rightUser.data())->User.Sid) != FALSE;
}
std::wstring image(HANDLE process) {
  std::wstring path(32768, L'\0'); DWORD size = static_cast<DWORD>(path.size());
  require(QueryFullProcessImageNameW(process, 0, path.data(), &size) != FALSE, "identity_invalid"); path.resize(size); return path;
}
}

void HostIdentity::authenticate(Json const& params) {
  require(parent == nullptr, "identity_invalid");
  auto pidValue = number(params, "parentPid", 1, MAXDWORD); require(static_cast<DWORD>(pidValue) == actualParent(), "identity_invalid");
  ULONG inputServer = 0, outputServer = 0;
  require(GetNamedPipeServerProcessId(GetStdHandle(STD_INPUT_HANDLE), &inputServer) &&
    GetNamedPipeServerProcessId(GetStdHandle(STD_OUTPUT_HANDLE), &outputServer) &&
    inputServer == static_cast<DWORD>(pidValue) && outputServer == static_cast<DWORD>(pidValue), "identity_invalid");
  Handle candidate(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, static_cast<DWORD>(pidValue)));
  require(candidate.get() != nullptr && WaitForSingleObject(candidate.get(), 0) == WAIT_TIMEOUT, "identity_invalid");
  DWORD ownSession = 0, hostSession = 0;
  require(ProcessIdToSessionId(GetCurrentProcessId(), &ownSession) && ProcessIdToSessionId(static_cast<DWORD>(pidValue), &hostSession) &&
    ownSession == hostSession && sameUser(GetCurrentProcess(), candidate.get()), "identity_invalid");
  auto uiAccess = tokenInformation(candidate.get(), TokenUIAccess);
  require(*reinterpret_cast<DWORD*>(uiAccess.data()) == 0, "identity_invalid");
  FILETIME created{}, exited{}, kernel{}, user{}, ownCreated{};
  require(GetProcessTimes(candidate.get(), &created, &exited, &kernel, &user) &&
    GetProcessTimes(GetCurrentProcess(), &ownCreated, &exited, &kernel, &user), "identity_invalid");
  ULARGE_INTEGER hostTime{}, ownTime{};
  hostTime.LowPart = created.dwLowDateTime; hostTime.HighPart = created.dwHighDateTime;
  ownTime.LowPart = ownCreated.dwLowDateTime; ownTime.HighPart = ownCreated.dwHighDateTime;
  require(hostTime.QuadPart <= ownTime.QuadPart, "identity_invalid");
  auto digest = fileHash(image(candidate.get()));
  require(constantEqual(digest, FCODE_HOST_IMAGE_SHA256) && constantEqual(digest, text(params, "parentImageSha256", 64)), "identity_invalid");
  requireHostRole(static_cast<DWORD>(pidValue), candidate.get(), image(candidate.get()));
  require(DuplicateHandle(GetCurrentProcess(), candidate.get(), GetCurrentProcess(), &parent, 0, FALSE, DUPLICATE_SAME_ACCESS) != FALSE, "identity_invalid");
  parentPid = static_cast<DWORD>(pidValue);
}
bool HostIdentity::alive() const { return parent && WaitForSingleObject(parent, 0) == WAIT_TIMEOUT; }
bool HostIdentity::isControlClient(HANDLE pipe) const {
  ULONG client = 0; return alive() && GetNamedPipeClientProcessId(pipe, &client) && client == parentPid;
}
std::wstring HostIdentity::logonSid() const {
  auto groups = tokenInformation(GetCurrentProcess(), TokenGroups);
  auto list = reinterpret_cast<TOKEN_GROUPS*>(groups.data());
  for (DWORD i = 0; i < list->GroupCount; ++i) if ((list->Groups[i].Attributes & SE_GROUP_LOGON_ID) == SE_GROUP_LOGON_ID) {
    LPWSTR sid = nullptr; require(ConvertSidToStringSidW(list->Groups[i].Sid, &sid) != FALSE, "identity_invalid");
    std::wstring result(sid); LocalFree(sid); return result;
  }
  throw Error("identity_invalid");
}
HostIdentity::~HostIdentity() { if (parent) CloseHandle(parent); }

bool interactiveDesktop() {
  HDESK input = OpenInputDesktop(0, FALSE, DESKTOP_READOBJECTS);
  if (!input) return false;
  wchar_t name[256]{}; DWORD length = 0;
  bool result = GetUserObjectInformationW(input, UOI_NAME, name, sizeof(name), &length) && _wcsicmp(name, L"Default") == 0;
  CloseDesktop(input);
  wchar_t ownName[256]{};
  return result && GetUserObjectInformationW(GetThreadDesktop(GetCurrentThreadId()), UOI_NAME, ownName, sizeof(ownName), &length) &&
    _wcsicmp(ownName, L"Default") == 0;
}
DWORD windowsBuild() {
  using RtlGetVersionFunction = LONG(WINAPI*)(PRTL_OSVERSIONINFOW);
  auto address = GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlGetVersion");
  require(address != nullptr, "backend_unavailable");
  auto function = reinterpret_cast<RtlGetVersionFunction>(address);
  RTL_OSVERSIONINFOW version{}; version.dwOSVersionInfoSize = sizeof(version);
  require(function(&version) == 0, "backend_unavailable"); return version.dwBuildNumber;
}
}
