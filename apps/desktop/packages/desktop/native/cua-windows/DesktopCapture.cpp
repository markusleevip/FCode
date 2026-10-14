#include "DesktopControl.h"
#include <d3d11.h>
#include <dxgi.h>
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>
#include <winrt/Windows.Graphics.DirectX.h>
#include <chrono>
#include <condition_variable>

namespace fcode::cua {
namespace {
using namespace winrt::Windows::Graphics::Capture;
using namespace winrt::Windows::Graphics::DirectX;
using namespace winrt::Windows::Graphics::DirectX::Direct3D11;
constexpr uint64_t MaxDesktopBytes = 128 * 1024 * 1024;
struct DesktopCaptureFrame {
  std::mutex mutex;
  std::condition_variable available;
  Direct3D11CaptureFrame frame{nullptr};
  bool failed = false;
};
}
CapturedWindow captureDesktopMonitor(DesktopDisplay const& display, std::function<bool()> const& live,
    std::function<void(std::vector<uint8_t>&)> const& mask) {
  require(live() && interactiveDesktop(), "not_authorized"); require(GraphicsCaptureSession::IsSupported(), "capture_unsupported");
  winrt::com_ptr<ID3D11Device> device; winrt::com_ptr<ID3D11DeviceContext> context; D3D_FEATURE_LEVEL level{};
  winrt::check_hresult(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
    nullptr, 0, D3D11_SDK_VERSION, device.put(), &level, context.put()));
  auto dxgi = device.as<IDXGIDevice>(); winrt::com_ptr<IInspectable> projected;
  winrt::check_hresult(CreateDirect3D11DeviceFromDXGIDevice(dxgi.get(), projected.put()));
  auto directDevice = projected.as<IDirect3DDevice>();
  auto interop = winrt::get_activation_factory<GraphicsCaptureItem, IGraphicsCaptureItemInterop>();
  GraphicsCaptureItem item{nullptr};
  winrt::check_hresult(interop->CreateForMonitor(display.handle, winrt::guid_of<GraphicsCaptureItem>(), winrt::put_abi(item)));
  auto size = item.Size();
  require(size.Width == display.bounds.right - display.bounds.left && size.Height == display.bounds.bottom - display.bounds.top, "observation_stale");
  require(size.Width > 0 && size.Height > 0 && uint64_t{static_cast<uint32_t>(size.Width)} * size.Height * 4 <= MaxDesktopBytes, "resource_limit");
  auto pool = Direct3D11CaptureFramePool::CreateFreeThreaded(directDevice, DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, size);
  auto state = std::make_shared<DesktopCaptureFrame>();
  auto subscription = pool.FrameArrived(winrt::auto_revoke, [state](auto const& sender, auto const&) {
    std::lock_guard lock(state->mutex);
    try { if (!state->frame) state->frame = sender.TryGetNextFrame(); } catch (...) { state->failed = true; }
    state->available.notify_one();
  });
  auto session = pool.CreateCaptureSession(item); session.IsCursorCaptureEnabled(false); session.StartCapture();
  Direct3D11CaptureFrame frame{nullptr};
  { std::unique_lock lock(state->mutex); auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(3);
    while (!state->frame && !state->failed && live() && std::chrono::steady_clock::now() < deadline) state->available.wait_for(lock, std::chrono::milliseconds(50));
    frame = state->frame;
  }
  subscription.revoke(); session.Close(); require(live(), "canceled"); require(frame != nullptr, "capture_frame_timeout");
  auto content = frame.ContentSize(); require(content.Width == size.Width && content.Height == size.Height, "observation_stale");
  auto surface = frame.Surface().as<::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess>();
  winrt::com_ptr<ID3D11Texture2D> texture; winrt::check_hresult(surface->GetInterface(__uuidof(ID3D11Texture2D), texture.put_void()));
  D3D11_TEXTURE2D_DESC description{}; texture->GetDesc(&description);
  require(description.Width >= static_cast<UINT>(content.Width) && description.Height >= static_cast<UINT>(content.Height) && description.Format == DXGI_FORMAT_B8G8R8A8_UNORM, "capture_unavailable");
  description.BindFlags = 0; description.MiscFlags = 0; description.CPUAccessFlags = D3D11_CPU_ACCESS_READ; description.Usage = D3D11_USAGE_STAGING;
  winrt::com_ptr<ID3D11Texture2D> staging; winrt::check_hresult(device->CreateTexture2D(&description, nullptr, staging.put()));
  context->CopyResource(staging.get(), texture.get());
  D3D11_MAPPED_SUBRESOURCE mapped{}; winrt::check_hresult(context->Map(staging.get(), 0, D3D11_MAP_READ, 0, &mapped));
  auto width = static_cast<uint32_t>(content.Width), height = static_cast<uint32_t>(content.Height);
  std::vector<uint8_t> pixels(static_cast<size_t>(width) * height * 4);
  for (uint32_t row = 0; row < height; ++row) std::memcpy(pixels.data() + static_cast<size_t>(row) * width * 4,
    static_cast<const uint8_t*>(mapped.pData) + static_cast<size_t>(row) * mapped.RowPitch, static_cast<size_t>(width) * 4);
  context->Unmap(staging.get(), 0); frame.Close(); pool.Close();
  require(live(), "canceled");
  bool visibleColor = false;
  for (size_t index = 0; index + 3 < pixels.size(); index += 4) if (pixels[index] || pixels[index + 1] || pixels[index + 2]) { visibleColor = true; break; }
  require(visibleColor, "capture_unavailable");
  mask(pixels); require(live(), "canceled"); return encodePng(width, height, pixels);
}
}
