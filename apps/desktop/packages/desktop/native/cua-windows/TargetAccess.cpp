#include "TargetAccess.h"

namespace fcode::cua {
namespace {
std::vector<uint8_t> information(HANDLE token, TOKEN_INFORMATION_CLASS kind) {
  DWORD size = 0;
  GetTokenInformation(token, kind, nullptr, 0, &size);
  require(size > 0 && size <= 64 * 1024, "target_access_denied");
  std::vector<uint8_t> bytes(size);
  require(GetTokenInformation(token, kind, bytes.data(), size, &size) != FALSE, "target_access_denied");
  return bytes;
}
DWORD integrity(HANDLE token) {
  auto bytes = information(token, TokenIntegrityLevel);
  auto sid = reinterpret_cast<TOKEN_MANDATORY_LABEL*>(bytes.data())->Label.Sid;
  require(IsValidSid(sid), "target_access_denied");
  auto count = *GetSidSubAuthorityCount(sid);
  require(count > 0, "target_access_denied");
  return *GetSidSubAuthority(sid, count - 1);
}
}
void requireTargetAccess(HANDLE process, DWORD pid) {
  require(process && WaitForSingleObject(process, 0) == WAIT_TIMEOUT, "target_unavailable");
  DWORD ownSession = 0, targetSession = 0;
  require(ProcessIdToSessionId(GetCurrentProcessId(), &ownSession) && ProcessIdToSessionId(pid, &targetSession) &&
    ownSession == targetSession, "target_access_denied");
  HANDLE ownRaw = nullptr, targetRaw = nullptr;
  require(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &ownRaw) != FALSE, "target_access_denied");
  Handle own(ownRaw);
  require(OpenProcessToken(process, TOKEN_QUERY, &targetRaw) != FALSE, "target_access_denied");
  Handle target(targetRaw);
  auto ownUser = information(own.get(), TokenUser), targetUser = information(target.get(), TokenUser);
  require(EqualSid(reinterpret_cast<TOKEN_USER*>(ownUser.data())->User.Sid,
    reinterpret_cast<TOKEN_USER*>(targetUser.data())->User.Sid) != FALSE, "target_access_denied");
  auto uiAccess = information(target.get(), TokenUIAccess);
  require(*reinterpret_cast<DWORD*>(uiAccess.data()) == 0 && integrity(target.get()) <= integrity(own.get()), "target_access_denied");
}
}
