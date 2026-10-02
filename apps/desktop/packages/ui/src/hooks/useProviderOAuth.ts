import { useEffect, useRef, useState } from "react";
import { useServices } from "./useServices.js";
import {
  EMPTY_PROVIDER_OAUTH_SETTINGS,
  ProviderOAuthSettingsController,
} from "../lib/providerOAuthSettingsController.js";
import type { ProviderOAuthSupplier } from "@fcode/services";

export function useProviderOAuth(onConnected?: (providerId: string) => void) {
  const { providerOAuthService, providerSettingsService } = useServices();
  const connectedRef = useRef(onConnected);
  connectedRef.current = onConnected;
  const controllerRef = useRef<ProviderOAuthSettingsController | null>(null);
  const [state, setState] = useState(EMPTY_PROVIDER_OAUTH_SETTINGS);
  useEffect(() => {
    // effect 内创建使 StrictMode 的 setup/cleanup/setup 不复用已 dispose 的 controller。
    const controller = new ProviderOAuthSettingsController(
      providerOAuthService,
      providerSettingsService,
      (id) => connectedRef.current?.(id),
    );
    controllerRef.current = controller;
    const unsubscribe = controller.subscribe(setState);
    setState(controller.getSnapshot());
    void controller.load();
    let polling = false;
    const timer = setInterval(() => {
      if (polling) return;
      polling = true;
      void controller
        .poll()
        .then(() => controller.load())
        .finally(() => {
          polling = false;
        });
    }, 1500);
    return () => {
      clearInterval(timer);
      unsubscribe();
      if (controllerRef.current === controller) controllerRef.current = null;
      void controller.dispose();
    };
  }, [providerOAuthService, providerSettingsService]);
  return {
    state,
    startLogin: (supplier: ProviderOAuthSupplier, accountId?: string, projectId?: string) =>
      controllerRef.current?.startLogin(supplier, accountId, projectId),
    cancelLogin: () => controllerRef.current?.cancelLogin(),
    submitCallback: (url: string) => controllerRef.current?.submitCallback(url),
    connectAccount: (id: string) => controllerRef.current?.connectAccount(id),
    setEnabled: (id: string, enabled: boolean) => controllerRef.current?.setEnabled(id, enabled),
    removeAccount: (id: string) => controllerRef.current?.removeAccount(id),
    refreshAccount: (id: string) => controllerRef.current?.refreshAccount(id),
    reload: () => controllerRef.current?.load(),
    retry: () => controllerRef.current?.retry(),
    importFile: async (file: File, location?: string) => {
      const controller = controllerRef.current;
      if (!controller) return;
      try {
        if (file.size > 1_048_576) {
          controller.reportError("importFailed");
          return;
        }
        // 文件仅作为用户提供的一次性输入；不显示或缓存 JSON，也不记录内容。
        const json = await file.text();
        await controller.importAccount(json, location);
      } catch {
        controller.reportError("importFailed");
      }
    },
  };
}
