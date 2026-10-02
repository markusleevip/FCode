import { useCallback, useEffect, useRef, useState } from "react";
import type { ProviderOAuthUsageView } from "@fcode/services";
import { useServices } from "@/hooks/useServices.js";

/** 挂载时查询一次；autoRefreshMs 仅供长驻的设置页使用，对话页弹层只在打开时查询。 */
export function useProviderOAuthUsage(accountId: string, autoRefreshMs?: number) {
  const { providerOAuthService } = useServices();
  const [view, setView] = useState<ProviderOAuthUsageView>();
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);

  const reload = useCallback(async () => {
    if (!providerOAuthService) return;
    const current = ++generation.current;
    setLoading(true);
    try {
      const next = await providerOAuthService.getUsage(accountId);
      if (generation.current !== current) return;
      setView(next);
      setFailed(false);
    } catch {
      if (generation.current === current) setFailed(true);
    } finally {
      if (generation.current === current) setLoading(false);
    }
  }, [accountId, providerOAuthService]);

  useEffect(() => {
    void reload();
    const timer = autoRefreshMs ? setInterval(() => void reload(), autoRefreshMs) : undefined;
    return () => {
      generation.current += 1;
      if (timer) clearInterval(timer);
    };
  }, [reload, autoRefreshMs]);

  return { view, failed, loading, reload };
}
