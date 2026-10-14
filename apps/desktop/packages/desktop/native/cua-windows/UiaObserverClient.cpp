#include "UiaObserver.h"
#include <memory>
#ifdef GetObject
#undef GetObject
#endif

namespace fcode::cua {
namespace {
struct Attributes {
  std::vector<uint8_t> storage;
  LPPROC_THREAD_ATTRIBUTE_LIST list = nullptr;
  Attributes() {
    SIZE_T size = 0;
    InitializeProcThreadAttributeList(nullptr, 1, 0, &size);
    require(size > 0 && size < 65536, "uia_worker_unavailable");
    storage.resize(size);
    list = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
    require(InitializeProcThreadAttributeList(list, 1, 0, &size) != FALSE, "uia_worker_unavailable");
  }
  ~Attributes() { if (list) DeleteProcThreadAttributeList(list); }
};
struct Worker {
  PROCESS_INFORMATION process{};
  ~Worker() {
    if (process.hProcess) {
      if (WaitForSingleObject(process.hProcess, 0) == WAIT_TIMEOUT) {
        TerminateProcess(process.hProcess, 1);
        WaitForSingleObject(process.hProcess, 1000);
      }
      CloseHandle(process.hProcess);
    }
    if (process.hThread) CloseHandle(process.hThread);
  }
};
}

namespace {
Json runWorker(WindowIdentity const& window, Json const& work, HANDLE cancellation, std::function<bool()> const& live) {
  require(live(), "canceled");
  wchar_t executable[32768]{};
  require(GetModuleFileNameW(nullptr, executable, static_cast<DWORD>(std::size(executable))) > 0, "uia_worker_unavailable");
  SECURITY_ATTRIBUTES security{ sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE };
  HANDLE requestRead = nullptr, requestWrite = nullptr;
  require(CreatePipe(&requestRead, &requestWrite, &security, 65536) != FALSE, "uia_worker_unavailable");
  Handle input(requestRead), writeRequest(requestWrite);
  HANDLE responseRead = nullptr, responseWrite = nullptr;
  require(CreatePipe(&responseRead, &responseWrite, &security, 65536) != FALSE, "uia_worker_unavailable");
  Handle readResponse(responseRead), output(responseWrite);
  require(SetHandleInformation(writeRequest.get(), HANDLE_FLAG_INHERIT, 0) &&
    SetHandleInformation(readResponse.get(), HANDLE_FLAG_INHERIT, 0), "uia_worker_unavailable");
  Handle errors(CreateFileW(L"NUL", GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, &security, OPEN_EXISTING, 0, nullptr));
  require(errors.get() != INVALID_HANDLE_VALUE, "uia_worker_unavailable");
  std::vector<HANDLE> inherited{ input.get(), output.get(), errors.get() };
  if (cancellation) inherited.push_back(cancellation);
  Attributes attributes;
  require(UpdateProcThreadAttribute(attributes.list, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
    inherited.data(), inherited.size() * sizeof(HANDLE), nullptr, nullptr) != FALSE, "uia_worker_unavailable");
  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = input.get(); startup.StartupInfo.hStdOutput = output.get(); startup.StartupInfo.hStdError = errors.get();
  startup.lpAttributeList = attributes.list;
  Handle job(CreateJobObjectW(nullptr, nullptr));
  require(job.get() != nullptr, "uia_worker_unavailable");
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_PROCESS_MEMORY;
  limits.BasicLimitInformation.ActiveProcessLimit = 1;
  limits.ProcessMemoryLimit = 384 * 1024 * 1024;
  require(SetInformationJobObject(job.get(), JobObjectExtendedLimitInformation, &limits, sizeof(limits)) != FALSE, "uia_worker_unavailable");
  Worker worker;
  auto command = L"\"" + std::wstring(executable) + (cancellation ? L"\" --uia-action" : L"\" --uia-observer");
  require(CreateProcessW(executable, command.data(), nullptr, nullptr, TRUE,
    CREATE_NO_WINDOW | CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT, nullptr, nullptr,
    &startup.StartupInfo, &worker.process) != FALSE, "uia_worker_unavailable");
  require(AssignProcessToJobObject(job.get(), worker.process.hProcess) != FALSE, "uia_worker_unavailable");
  require(live() && ResumeThread(worker.process.hThread) != static_cast<DWORD>(-1), "canceled");
  const auto deadline = work.HasKey(L"deadline") ? std::min(GetTickCount64() + 3000, static_cast<uint64_t>(number(work, "deadline"))) : GetTickCount64() + 3000;
  Json request;
  put(request, "parentPid", uint64_t{GetCurrentProcessId()}); put(request, "pid", uint64_t{window.process->pid});
  put(request, "instanceId", window.process->instanceId); put(request, "hwnd", std::to_string(reinterpret_cast<uintptr_t>(window.hwnd)));
  put(request, "threadId", uint64_t{window.threadId}); put(request, "deadline", deadline);
  for (auto const& pair : work) if (pair.Key() != L"deadline") request.Insert(pair.Key(), pair.Value());
  if (cancellation) put(request, "cancelHandle", std::to_string(reinterpret_cast<uintptr_t>(cancellation)));
  auto bytes = stringify(request) + "\n";
  require(bytes.size() < 65536, "resource_limit");
  DWORD written = 0;
  require(WriteFile(writeRequest.get(), bytes.data(), static_cast<DWORD>(bytes.size()), &written, nullptr) && written == bytes.size(), "uia_worker_unavailable");
  std::string response;
  for (;;) {
    require(live(), "canceled");
    require(GetTickCount64() < deadline, "uia_timeout");
    DWORD available = 0;
    if (!PeekNamedPipe(readResponse.get(), nullptr, 0, nullptr, &available, nullptr)) throw Error("uia_worker_failed");
    if (available) {
      require(response.size() + available <= 65536, "resource_limit");
      std::string chunk(available, '\0'); DWORD received = 0;
      require(ReadFile(readResponse.get(), chunk.data(), available, &received, nullptr) != FALSE && received > 0, "uia_worker_failed");
      response.append(chunk.data(), received);
      auto newline = response.find('\n');
      if (newline != std::string::npos) {
        require(newline + 1 == response.size(), "protocol_invalid");
        auto result = parse(response.substr(0, newline), 65536);
        if (result.HasKey(L"error")) {
          exact(result, {"error"}, {"error"});
          auto code = text(result, "error", 64);
          require(code == "uia_unavailable" || code == "target_changed" || code == "target_access_denied" || code == "uia_timeout" ||
            code == "unsupported_action" || code == "sensitive_target" || code == "observation_stale" || code == "execution_uncertain", "protocol_invalid");
          throw Error(code);
        }
        if (cancellation) {
          if (result.HasKey(L"receiver")) {
            auto receiver = object(result, "receiver"); exact(receiver, {"hwnd", "threadId"}, {"hwnd", "threadId"});
            text(receiver, "hwnd", 32); number(receiver, "threadId", 1, MAXDWORD);
          }
          if (text(work, "action", 32) == "prepare") { exact(result, {"receiver"}, {"receiver"}); return result; }
          exact(result, {"status", "effectVerified", "inputRouting", "inputBackend", "receiver"}, {"status", "effectVerified", "inputRouting", "inputBackend"});
          auto backend = text(result, "inputBackend", 64);
          require(text(result, "status", 64) == "dispatched" && !boolean(result, "effectVerified") && text(result, "inputRouting", 64) == "background" &&
            backend == "win32-window-messages", "protocol_invalid");
          return result;
        }
        exact(result, {"elements", "bindings", "truncated", "reason"}, {"elements", "bindings", "truncated"});
        auto elements = result.Lookup(L"elements");
        require(elements.ValueType() == JsonType::Array && elements.GetArray().Size() <= 300, "protocol_invalid");
        auto bindings = result.Lookup(L"bindings");
        require(bindings.ValueType() == JsonType::Array && bindings.GetArray().Size() == elements.GetArray().Size(), "protocol_invalid");
        auto truncated = boolean(result, "truncated");
        require(truncated == result.HasKey(L"reason"), "protocol_invalid");
        if (truncated) require(text(result, "reason", 64) == "uia_observation_limit", "protocol_invalid");
        for (uint32_t index = 0; index < elements.GetArray().Size(); ++index) {
          auto item = elements.GetArray().GetAt(index);
          require(item.ValueType() == JsonType::Object, "protocol_invalid");
          auto element = item.GetObject();
          exact(element, {"index", "role", "enabled", "isPassword", "actions", "name", "value"}, {"index", "role", "enabled", "isPassword", "actions"});
          require(number(element, "index", 0, 299) == index, "protocol_invalid");
          text(element, "role", 64); boolean(element, "enabled");
          require(!boolean(element, "isPassword") || (!element.HasKey(L"name") && !element.HasKey(L"value")), "protocol_invalid");
          auto actions = element.Lookup(L"actions");
          require(actions.ValueType() == JsonType::Array && actions.GetArray().Size() <= 1, "protocol_invalid");
          if (actions.GetArray().Size() > 0) {
            auto action = actions.GetArray().GetAt(0);
            require(action.ValueType() == JsonType::String && !boolean(element, "isPassword") && boolean(element, "enabled"), "protocol_invalid");
            require((action.GetString() == L"press" && text(element, "role", 64) == "Button") ||
              (action.GetString() == L"set_value" && text(element, "role", 64) == "Edit"), "protocol_invalid");
          }
          if (element.HasKey(L"name")) {
            auto name = element.Lookup(L"name");
            require(name.ValueType() == JsonType::String && name.GetString().size() <= 1024, "protocol_invalid");
          }
          if (element.HasKey(L"value")) {
            auto value = element.Lookup(L"value");
            require(value.ValueType() == JsonType::String && value.GetString().size() <= 4096, "protocol_invalid");
          }
          auto binding = bindings.GetArray().GetAt(index);
          require(binding.ValueType() == JsonType::String && binding.GetString().size() <= 2048, "protocol_invalid");
        }
        return result;
      }
    }
    if (WaitForSingleObject(worker.process.hProcess, 10) == WAIT_OBJECT_0) {
      // Drain any response written immediately before normal worker exit.
      DWORD remaining = 0;
      if (!PeekNamedPipe(readResponse.get(), nullptr, 0, nullptr, &remaining, nullptr) || !remaining) throw Error("uia_worker_failed");
    }
  }
}
}
Json observeUia(WindowIdentity const& window, std::function<bool()> const& live) {
  return runWorker(window, Json{}, nullptr, live);
}
Json executeUia(WindowIdentity const& window, Json const& work, HANDLE cancellation, std::function<bool()> const& live) {
  require(cancellation != nullptr, "not_authorized");
  return runWorker(window, work, cancellation, live);
}
}
