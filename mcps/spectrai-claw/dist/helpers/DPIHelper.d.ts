export interface ScreenInfo {
    width: number;
    height: number;
    dpiX: number;
    dpiY: number;
    scaleFactor: number;
}
export declare function getScreenInfo(): Promise<ScreenInfo>;
export declare function logicalToPhysical(x: number, y: number, scaleFactor: number): {
    x: number;
    y: number;
};
export declare function physicalToLogical(x: number, y: number, scaleFactor: number): {
    x: number;
    y: number;
};
export declare function clearCache(): void;
