#pragma once
#include <winrt/Windows.Data.Json.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <initializer_list>
#include <stdexcept>
#include <string>
#include <string_view>
#include <unordered_set>

namespace fcode::cua {
using Json = winrt::Windows::Data::Json::JsonObject;
using JsonArray = winrt::Windows::Data::Json::JsonArray;
using JsonValue = winrt::Windows::Data::Json::JsonValue;
using JsonType = winrt::Windows::Data::Json::JsonValueType;
constexpr size_t RequestBytes = 1024 * 1024;
constexpr size_t ResponseBytes = 32 * 1024 * 1024;
constexpr size_t ControlBytes = 16 * 1024;
constexpr unsigned JsonDepth = 64;
constexpr uint64_t SafeInteger = 9007199254740991ULL;

struct Error : std::runtime_error {
  explicit Error(std::string code) : std::runtime_error(code), code(std::move(code)) {}
  std::string code;
};

inline void require(bool condition, const char* code = "invalid_request") {
  if (!condition) throw Error(code);
}
inline winrt::hstring wide(std::string_view value) { return winrt::to_hstring(value); }
inline std::string utf8(winrt::hstring const& value) { return winrt::to_string(value); }
inline void exact(Json const& object, std::initializer_list<std::string_view> fields,
    std::initializer_list<std::string_view> required) {
  for (auto const& pair : object) {
    auto key = utf8(pair.Key());
    require(std::find(fields.begin(), fields.end(), key) != fields.end());
  }
  for (auto const& key : required) require(object.HasKey(wide(key)));
}
inline std::string text(Json const& object, std::string_view key, size_t limit = 2048) {
  auto value = object.Lookup(wide(key));
  require(value.ValueType() == JsonType::String);
  auto result = utf8(value.GetString());
  require(!result.empty() && result.size() <= limit);
  return result;
}
inline int64_t number(Json const& object, std::string_view key, int64_t minimum = 1,
    int64_t maximum = static_cast<int64_t>(SafeInteger)) {
  auto value = object.Lookup(wide(key));
  require(value.ValueType() == JsonType::Number);
  auto numeric = value.GetNumber();
  require(std::isfinite(numeric) && std::trunc(numeric) == numeric && numeric >= static_cast<double>(minimum) &&
    numeric <= static_cast<double>(maximum));
  return static_cast<int64_t>(numeric);
}
inline Json object(Json const& value, std::string_view key) {
  auto result = value.Lookup(wide(key)); require(result.ValueType() == JsonType::Object); return result.GetObject();
}
inline bool boolean(Json const& value, std::string_view key) {
  auto result = value.Lookup(wide(key)); require(result.ValueType() == JsonType::Boolean); return result.GetBoolean();
}
inline void put(Json const& object, std::string_view key, std::string_view value) {
  object.Insert(wide(key), JsonValue::CreateStringValue(wide(value)));
}
inline void put(Json const& object, std::string_view key, uint64_t value) {
  require(value <= SafeInteger); object.Insert(wide(key), JsonValue::CreateNumberValue(static_cast<double>(value)));
}
inline void putBool(Json const& object, std::string_view key, bool value) {
  object.Insert(wide(key), JsonValue::CreateBooleanValue(value));
}

/** WinRT JSON accepts duplicate keys, so scan and normalize every key before parsing. */
class JsonScanner {
public:
  explicit JsonScanner(std::string_view input) : input(input) {}
  void validate() { item(0); space(); require(offset == input.size(), "protocol_invalid"); }
private:
  std::string_view input;
  size_t offset = 0;
  void space() { while (offset < input.size() && (input[offset] == ' ' || input[offset] == '\t' || input[offset] == '\r' || input[offset] == '\n')) ++offset; }
  char peek() const { return offset < input.size() ? input[offset] : '\0'; }
  std::string string() {
    auto start = offset; require(peek() == '"', "protocol_invalid"); ++offset;
    while (offset < input.size()) {
      char character = input[offset++];
      if (character == '\\') { ++offset; continue; }
      if (character == '"') {
        auto parsed = JsonValue::Parse(wide(input.substr(start, offset - start)));
        require(parsed.ValueType() == JsonType::String, "protocol_invalid");
        return utf8(parsed.GetString());
      }
    }
    throw Error("protocol_invalid");
  }
  void item(unsigned depth) {
    require(depth <= JsonDepth, "protocol_invalid"); space();
    if (peek() == '"') { string(); return; }
    if (peek() == '{' || peek() == '[') {
      bool isObject = peek() == '{'; char close = isObject ? '}' : ']'; ++offset; space();
      if (peek() == close) { ++offset; return; }
      std::unordered_set<std::string> keys;
      while (offset < input.size()) {
        if (isObject) {
          space(); auto key = string(); require(keys.insert(key).second, "protocol_invalid");
          space(); require(peek() == ':', "protocol_invalid"); ++offset;
        }
        item(depth + 1); space();
        if (peek() == close) { ++offset; return; }
        require(peek() == ',', "protocol_invalid"); ++offset;
      }
      throw Error("protocol_invalid");
    }
    auto start = offset;
    while (offset < input.size() && peek() != ',' && peek() != '}' && peek() != ']' &&
      peek() != ' ' && peek() != '\t' && peek() != '\r' && peek() != '\n') ++offset;
    require(start != offset, "protocol_invalid");
  }
};

inline Json parse(std::string_view value, size_t limit = RequestBytes) {
  require(value.size() <= limit, "resource_limit");
  try { JsonScanner(value).validate(); return Json::Parse(wide(value)); }
  catch (Error const&) { throw; }
  catch (...) { throw Error("protocol_invalid"); }
}
inline std::string stringify(Json const& value) { return utf8(value.Stringify()); }
inline void envelope(Json const& value) {
  exact(value, {"schemaVersion", "id", "method", "params"}, {"schemaVersion", "id", "method", "params"});
  require(number(value, "schemaVersion") == 2); text(value, "id", 128); text(value, "method", 64); object(value, "params");
}
inline Json success(std::string_view id, Json const& result) {
  Json value; put(value, "schemaVersion", uint64_t{2}); put(value, "id", id); value.Insert(L"result", result); return value;
}
inline Json failure(std::string_view id, std::string_view code) {
  Json error; put(error, "code", code); put(error, "message", std::string("Windows Computer Use: ") + std::string(code));
  Json value; put(value, "schemaVersion", uint64_t{2}); put(value, "id", id); value.Insert(L"error", error); return value;
}
}
