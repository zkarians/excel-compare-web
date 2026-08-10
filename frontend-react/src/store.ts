import { create } from 'zustand';

interface AppState {
  originalData: any[];
  downloadData: any[];
  reworkData: any[];
  warehouseData: any[];
  currentTab: 'compare' | 'dbSearch' | 'settings';
  setOriginalData: (data: any[]) => void;
  setDownloadData: (data: any[]) => void;
  setReworkData: (data: any[]) => void;
  setWarehouseData: (data: any[]) => void;
  setCurrentTab: (tab: 'compare' | 'dbSearch' | 'settings') => void;
  syncRemote: boolean;
  setSyncRemote: (sync: boolean) => void;
}

export const useAppStore = create<AppState>((set) => ({
  originalData: [],
  downloadData: [],
  reworkData: [],
  warehouseData: [],
  currentTab: 'compare',
  setOriginalData: (data) => set({ originalData: data }),
  setDownloadData: (data) => set({ downloadData: data }),
  setReworkData: (data) => set({ reworkData: data }),
  setWarehouseData: (data) => set({ warehouseData: data }),
  setCurrentTab: (tab) => set({ currentTab: tab }),
  syncRemote: true,
  setSyncRemote: (sync) => set({ syncRemote: sync }),
}));
