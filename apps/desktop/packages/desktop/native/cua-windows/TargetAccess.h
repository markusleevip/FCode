#pragma once
#include "HostIdentity.h"

namespace fcode::cua {
void requireTargetAccess(HANDLE process, DWORD pid);
}
