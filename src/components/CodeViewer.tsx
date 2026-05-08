import Editor from "@monaco-editor/react";

export function CodeViewer({ code }: { code: string }) {
  return (
    <Editor
      height="100%"
      language="typescript"
      value={code}
      theme="vs-dark"
      options={{
        readOnly: true,
        minimap: { enabled: false },
        fontFamily: "var(--font-mono)",
        fontSize: 13,
        lineNumbers: "on",
        renderLineHighlight: "none",
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        padding: { top: 16, bottom: 16 },
        wordWrap: "on",
      }}
    />
  );
}
