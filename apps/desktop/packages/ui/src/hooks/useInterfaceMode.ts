import { useFCodeStoreWithDefault } from "@/store/StoreProvider.js";

export function useIsOfficeMode(): boolean {
  return useFCodeStoreWithDefault((state) => state.interfaceMode === "office", false);
}
