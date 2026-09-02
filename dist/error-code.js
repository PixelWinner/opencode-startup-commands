export function getErrorCode(error) {
    if (typeof error !== "object" || error === null || !("code" in error)) {
        return undefined;
    }
    const code = error.code;
    return typeof code === "string" ? code : undefined;
}
//# sourceMappingURL=error-code.js.map