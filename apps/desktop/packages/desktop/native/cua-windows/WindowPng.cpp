#include "WindowCapture.h"
#include <wincodec.h>
#include <wincrypt.h>
#include <objidl.h>
#include <vector>

namespace fcode::cua {
namespace {
constexpr uint32_t ImageEdge = 1600;
std::string base64(std::span<const uint8_t> bytes) {
  require(bytes.size() < MAXDWORD, "resource_limit"); DWORD size = 0;
  require(CryptBinaryToStringA(bytes.data(), static_cast<DWORD>(bytes.size()), CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF, nullptr, &size), "capture_unavailable");
  require(size <= ResponseBytes, "resource_limit"); std::string result(size, '\0');
  require(CryptBinaryToStringA(bytes.data(), static_cast<DWORD>(bytes.size()), CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF, result.data(), &size), "capture_unavailable");
  if (!result.empty() && result.back() == '\0') result.pop_back(); return result;
}
}
CapturedWindow encodePng(uint32_t width, uint32_t height, std::span<const uint8_t> pixels) {
  require(width > 0 && height > 0 && pixels.size() == static_cast<size_t>(width) * height * 4 && pixels.size() < MAXDWORD, "resource_limit");
  winrt::com_ptr<IWICImagingFactory> factory;
  winrt::check_hresult(CoCreateInstance(CLSID_WICImagingFactory2, nullptr, CLSCTX_INPROC_SERVER, __uuidof(IWICImagingFactory), factory.put_void()));
  winrt::com_ptr<IWICBitmap> bitmap;
  winrt::check_hresult(factory->CreateBitmapFromMemory(width, height, GUID_WICPixelFormat32bppBGRA, width * 4,
    static_cast<UINT>(pixels.size()), const_cast<BYTE*>(pixels.data()), bitmap.put()));
  auto scale = std::min(1.0, static_cast<double>(ImageEdge) / std::max(width, height));
  auto outputWidth = std::max(1U, static_cast<uint32_t>(std::lround(width * scale)));
  auto outputHeight = std::max(1U, static_cast<uint32_t>(std::lround(height * scale)));
  winrt::com_ptr<IWICBitmapScaler> scaler; winrt::check_hresult(factory->CreateBitmapScaler(scaler.put()));
  winrt::check_hresult(scaler->Initialize(bitmap.get(), outputWidth, outputHeight, WICBitmapInterpolationModeFant));
  winrt::com_ptr<IWICFormatConverter> converted; winrt::check_hresult(factory->CreateFormatConverter(converted.put()));
  winrt::check_hresult(converted->Initialize(scaler.get(), GUID_WICPixelFormat24bppBGR, WICBitmapDitherTypeNone, nullptr, 0, WICBitmapPaletteTypeCustom));
  winrt::com_ptr<IStream> memory; winrt::check_hresult(CreateStreamOnHGlobal(nullptr, TRUE, memory.put()));
  winrt::com_ptr<IWICBitmapEncoder> encoder; winrt::check_hresult(factory->CreateEncoder(GUID_ContainerFormatPng, nullptr, encoder.put()));
  winrt::check_hresult(encoder->Initialize(memory.get(), WICBitmapEncoderNoCache));
  winrt::com_ptr<IWICBitmapFrameEncode> frame; winrt::com_ptr<IPropertyBag2> properties;
  winrt::check_hresult(encoder->CreateNewFrame(frame.put(), properties.put())); winrt::check_hresult(frame->Initialize(properties.get()));
  winrt::check_hresult(frame->SetSize(outputWidth, outputHeight)); auto format = GUID_WICPixelFormat24bppBGR;
  winrt::check_hresult(frame->SetPixelFormat(&format)); require(IsEqualGUID(format, GUID_WICPixelFormat24bppBGR), "capture_pixel_format");
  winrt::check_hresult(frame->WriteSource(converted.get(), nullptr)); winrt::check_hresult(frame->Commit()); winrt::check_hresult(encoder->Commit());
  STATSTG info{}; winrt::check_hresult(memory->Stat(&info, STATFLAG_NONAME)); require(info.cbSize.QuadPart > 0 && info.cbSize.QuadPart < ResponseBytes / 2, "resource_limit");
  LARGE_INTEGER zero{}; winrt::check_hresult(memory->Seek(zero, STREAM_SEEK_SET, nullptr));
  std::vector<uint8_t> bytes(static_cast<size_t>(info.cbSize.QuadPart)); ULONG read = 0;
  winrt::check_hresult(memory->Read(bytes.data(), static_cast<ULONG>(bytes.size()), &read)); require(read == bytes.size(), "capture_unavailable");
  return CapturedWindow{ outputWidth, outputHeight, width, height, base64(bytes) };
}
}
