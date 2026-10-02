import { createContext, useContext, type ReactNode } from "react";
import type { CodingPlanUpgradeDialogTarget } from "@/settings/codingPlanUpgradeLoginRecovery.js";
import type { CodingPlanEntryInventory } from "@/hooks/useCodingPlanEntryPlanList.js";

interface CodingPlanUpgradeDialogContextValue {
  purchaseAvailable: boolean;
  inventory: CodingPlanEntryInventory;
  openCodingPlanUpgrade: (
    target: CodingPlanUpgradeDialogTarget,
    observation?: { signal: AbortSignal; onResult: (opened: boolean) => void },
  ) => boolean;
}

// FCode 不提供旧 Z.ai 套餐购买；在唯一入口明确拒绝，避免遗留回调重新打开官网 webview。
// 保留兼容契约供供应商配置消费，但不查询套餐、不挂载购买页面，也不改动用户凭据。
const unavailablePurchase: CodingPlanUpgradeDialogContextValue =
  Object.freeze<CodingPlanUpgradeDialogContextValue>({
    purchaseAvailable: false,
    inventory: Object.freeze({ entryPlanList: "", status: "ready", retry: () => {} }),
    openCodingPlanUpgrade: (_target, observation) => {
      if (observation && !observation.signal.aborted) observation.onResult(false);
      return false;
    },
  });
const CodingPlanUpgradeDialogContext = createContext<CodingPlanUpgradeDialogContextValue | null>(
  null,
);

export function CodingPlanUpgradeDialogProvider({ children }: { children: ReactNode }) {
  return (
    <CodingPlanUpgradeDialogContext.Provider value={unavailablePurchase}>
      {children}
    </CodingPlanUpgradeDialogContext.Provider>
  );
}

export function useCodingPlanUpgradeDialog() {
  const context = useContext(CodingPlanUpgradeDialogContext);
  if (!context)
    throw new Error(
      "useCodingPlanUpgradeDialog must be used within CodingPlanUpgradeDialogProvider",
    );
  return context;
}

export function useOptionalCodingPlanUpgradeDialog() {
  return useContext(CodingPlanUpgradeDialogContext);
}
