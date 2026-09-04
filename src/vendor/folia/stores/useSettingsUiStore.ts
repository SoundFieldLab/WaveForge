// WaveForge 桩实现：folia 应用外壳的设置 store（zustand + IndexedDB 持久化）。
// 可视化器子树只消费 enablePlayerPageNativeBlur 一个字段，桩固定返回默认值。
interface FoliaSettingsUiState {
    enablePlayerPageNativeBlur: boolean;
}

const foliaSettingsUiState: FoliaSettingsUiState = {
    enablePlayerPageNativeBlur: false,
};

export const useSettingsUiStore = <T>(selector: (state: FoliaSettingsUiState) => T): T =>
    selector(foliaSettingsUiState);

export default useSettingsUiStore;
