import {
  type KeybindingCommand,
  type ProjectId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
  type ThreadId,
  DEFAULT_RUNTIME_MODE,
} from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";

import ThreadTerminalDrawer from "./ThreadTerminalDrawer";
import BranchToolbar from "./BranchToolbar";
import { ChatHeader } from "./chat/ChatHeader";
import type { NewProjectScriptInput } from "./ProjectScriptsControl";
import { toastManager } from "./ui/toast";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { useStore } from "../store";
import { useComposerDraftStore } from "../composerDraftStore";
import { isElectron } from "../env";
import { cn } from "~/lib/utils";
import { SidebarTrigger } from "~/components/ui/sidebar";
import { APP_DISPLAY_NAME } from "../branding";
import { ensureNativeApi, readNativeApi } from "../nativeApi";
import { newCommandId } from "~/lib/utils";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { shortcutLabelForCommand } from "../keybindings";
import { serverConfigQueryOptions, serverQueryKeys } from "~/lib/serverReactQuery";
import { gitBranchesQueryOptions } from "~/lib/gitReactQuery";
import { commandForProjectScript, nextProjectScriptId } from "../projectScripts";
import { decodeProjectScriptKeybindingRule } from "~/lib/projectScriptKeybindings";
import { useLocalStorage } from "../hooks/useLocalStorage";
import {
  LAST_INVOKED_SCRIPT_BY_PROJECT_KEY,
  LastInvokedScriptByProjectSchema,
} from "./ChatView.logic";
import type { TerminalContextSelection } from "~/lib/terminalContext";

const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];
const EMPTY_EDITORS: ReadonlyArray<import("@t3tools/contracts").EditorId> = [];

interface TerminalThreadViewProps {
  threadId: ThreadId;
  diffOpen?: boolean;
}

export default function TerminalThreadView({ threadId, diffOpen = false }: TerminalThreadViewProps) {
  const projects = useStore((store) => store.projects);
  const thread = useStore((store) => store.threads.find((t) => t.id === threadId));
  const markThreadVisited = useStore((store) => store.markThreadVisited);
  const draftThread = useComposerDraftStore((store) =>
    store.draftThreadsByThreadId[threadId] ?? null,
  );
  const activeProject = thread
    ? projects.find((p) => p.id === thread.projectId)
    : draftThread
      ? projects.find((p) => p.id === draftThread.projectId)
      : undefined;

  const cwd = thread?.worktreePath ?? activeProject?.cwd ?? "/";
  const gitCwd = thread?.worktreePath ?? activeProject?.cwd ?? null;
  const isServerThread = !!thread;
  const promotingRef = useRef(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const terminalState = useTerminalStateStore((store) =>
    selectThreadTerminalState(store.terminalStateByThreadId, threadId),
  );

  const splitTerminal = useTerminalStateStore((store) => store.splitTerminal);
  const newTerminal = useTerminalStateStore((store) => store.newTerminal);
  const activateTerminal = useTerminalStateStore((store) => store.setActiveTerminal);
  const storeCloseTerminal = useTerminalStateStore((store) => store.closeTerminal);
  const setTerminalOpen = useTerminalStateStore((store) => store.setTerminalOpen);

  const [focusRequestId, setFocusRequestId] = useState(0);
  const openedRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerHeight, setContainerHeight] = useState(600);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");

  const { handleNewThread } = useHandleNewThread();

  // Server config for keybindings + available editors
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const keybindings = serverConfigQuery.data?.keybindings ?? EMPTY_KEYBINDINGS;
  const availableEditors = serverConfigQuery.data?.availableEditors ?? EMPTY_EDITORS;

  // Git info
  const branchesQuery = useQuery(gitBranchesQueryOptions(gitCwd));
  const isGitRepo = branchesQuery.data?.isRepo ?? true;

  const diffShortcutLabel = shortcutLabelForCommand(keybindings, "diff.toggle") ?? null;

  // Shortcut labels for terminal actions (Feature 5)
  const splitShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.split"),
    [keybindings],
  );
  const newShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.new"),
    [keybindings],
  );
  const closeShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.close"),
    [keybindings],
  );

  // Last invoked script tracking (Feature 6)
  const [lastInvokedScriptByProjectId, setLastInvokedScriptByProjectId] = useLocalStorage(
    LAST_INVOKED_SCRIPT_BY_PROJECT_KEY,
    {},
    LastInvokedScriptByProjectSchema,
  );
  const preferredScriptId = activeProject
    ? (lastInvokedScriptByProjectId[activeProject.id] ?? null)
    : null;

  // BranchToolbar env locked state (Feature 2)
  const envLocked = Boolean(
    thread &&
      (thread.messages.length > 0 ||
        (thread.session !== null && thread.session.status !== "closed")),
  );

  // --- Effects ---

  // Feature 1: Mark thread as visited (prevents "unread" in sidebar)
  useEffect(() => {
    if (!isServerThread) return;
    markThreadVisited(threadId);
  }, [threadId, isServerThread, markThreadVisited]);

  // Feature 3: Update document.title with thread name
  useEffect(() => {
    if (!isServerThread || !thread) return;
    const parts = [thread.title];
    if (activeProject?.name) parts.push(activeProject.name);
    parts.push(APP_DISPLAY_NAME);
    document.title = parts.join(" — ");
    return () => {
      document.title = APP_DISPLAY_NAME;
    };
  }, [isServerThread, thread?.title, activeProject?.name]); // eslint-disable-line react-hooks/exhaustive-deps

  // Promote draft thread to server thread immediately
  useEffect(() => {
    if (isServerThread || !draftThread || !activeProject || promotingRef.current) return;
    promotingRef.current = true;

    const api = ensureNativeApi();
    void api.orchestration.dispatchCommand({
      type: "thread.create",
      commandId: newCommandId(),
      threadId,
      projectId: activeProject.id as ProjectId,
      title: "New terminal",
      model: activeProject.model ?? "gpt-5-codex",
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: "default",
      branch: draftThread.branch ?? null,
      worktreePath: draftThread.worktreePath ?? null,
      createdAt: draftThread.createdAt,
    });
  }, [isServerThread, draftThread, activeProject, threadId]);

  // Auto-open terminal once thread exists on server (run only once per thread)
  useEffect(() => {
    if (!isServerThread || openedRef.current) return;
    openedRef.current = true;
    if (!terminalState.terminalOpen) {
      setTerminalOpen(threadId, true);
    }
    setFocusRequestId((prev) => prev + 1);
  }, [threadId, isServerThread]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset the opened guard when threadId changes
  useEffect(() => {
    openedRef.current = false;
  }, [threadId]);

  // Track container height to pass to the drawer (avoids resize dance)
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setContainerHeight(Math.round(entry.contentRect.height));
      }
    });
    observer.observe(el);
    setContainerHeight(Math.round(el.clientHeight));
    return () => observer.disconnect();
  }, []);

  // Feature 7: Test harness (dev only)
  useEffect(() => {
    if (import.meta.env.PROD) return;
    const harness = {
      getThreadState: () => {
        const state = JSON.parse(localStorage.getItem("t3code:terminal-state:v1") || "{}");
        const ts = state?.state?.terminalStateByThreadId?.[threadId];
        return {
          terminalIds: ts?.terminalIds,
          activeTerminalId: ts?.activeTerminalId,
          terminalOpen: ts?.terminalOpen,
        };
      },
      getDocTitle: () => document.title,
      getLastScripts: () =>
        JSON.parse(localStorage.getItem("t3code:last-invoked-script-by-project") || "{}"),
      getBranchToolbar: () => {
        const btns = Array.from(document.querySelectorAll("button"));
        const branch = btns.find((b) => b.textContent?.match(/main|master|branch/i));
        return { found: !!branch, text: branch?.textContent?.trim() };
      },
      getHeaderTitle: () => document.querySelector("header h2, header input")?.textContent,
      isRenaming: () => isRenaming,
      simulateSplit: () => {
        (document.activeElement || document).dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "d",
            code: "KeyD",
            metaKey: true,
            bubbles: true,
            cancelable: true,
            composed: true,
          }),
        );
      },
      simulateClose: () => {
        (document.activeElement || document).dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "w",
            code: "KeyW",
            metaKey: true,
            bubbles: true,
            cancelable: true,
            composed: true,
          }),
        );
      },
      simulateNewThread: () => {
        (document.activeElement || document).dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "t",
            code: "KeyT",
            metaKey: true,
            bubbles: true,
            cancelable: true,
            composed: true,
          }),
        );
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__atelier = harness;
    return () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (window as any).__atelier;
    };
  }, [threadId, isRenaming]);

  // --- Terminal callbacks ---

  const handleSplitTerminal = useCallback(() => {
    const newId = `split-${Date.now()}`;
    splitTerminal(threadId, newId);
  }, [splitTerminal, threadId]);

  const handleNewTerminal = useCallback(() => {
    const terminalId = `terminal-${Date.now()}`;
    newTerminal(threadId, terminalId);
  }, [newTerminal, threadId]);

  const handleActiveTerminalChange = useCallback(
    (terminalId: string) => {
      activateTerminal(threadId, terminalId);
    },
    [activateTerminal, threadId],
  );

  const handleCloseTerminal = useCallback(
    (terminalId: string) => {
      const api = readNativeApi();
      if (!api) return;

      const isFinalTerminal = terminalState.terminalIds.length <= 1;

      void (async () => {
        try {
          if ("close" in api.terminal && typeof api.terminal.close === "function") {
            await api.terminal.close({ threadId, terminalId, deleteHistory: true });
          } else {
            await api.terminal
              .write({ threadId, terminalId, data: "exit\n" })
              .catch(() => undefined);
          }
        } catch {
          await api.terminal
            .write({ threadId, terminalId, data: "exit\n" })
            .catch(() => undefined);
        }
      })();

      storeCloseTerminal(threadId, terminalId);
      if (isFinalTerminal) {
        setTerminalOpen(threadId, true);
      }
      setFocusRequestId((prev) => prev + 1);
    },
    [threadId, storeCloseTerminal, setTerminalOpen, terminalState.terminalIds.length],
  );

  const handleHeightChange = useCallback((_height: number) => {}, []);
  const handleAddTerminalContext = useCallback((_selection: TerminalContextSelection) => {}, []);

  // --- Feature 4: Double-click rename ---

  const startRename = useCallback(() => {
    setRenameValue(thread?.title ?? "");
    setIsRenaming(true);
  }, [thread?.title]);

  const commitRename = useCallback(async () => {
    const trimmed = renameValue.trim();
    setIsRenaming(false);
    if (!trimmed || trimmed === thread?.title) return;
    const api = readNativeApi();
    if (!api) return;
    await api.orchestration.dispatchCommand({
      type: "thread.meta.update",
      commandId: newCommandId(),
      threadId,
      title: trimmed,
    });
  }, [renameValue, thread?.title, threadId]);

  // --- Project script handlers ---

  const persistProjectScripts = useCallback(
    async (input: {
      projectId: ProjectId;
      projectCwd: string;
      previousScripts: ProjectScript[];
      nextScripts: ProjectScript[];
      keybinding?: string | null;
      keybindingCommand: KeybindingCommand;
    }) => {
      const api = readNativeApi();
      if (!api) return;

      await api.orchestration.dispatchCommand({
        type: "project.meta.update",
        commandId: newCommandId(),
        projectId: input.projectId,
        scripts: input.nextScripts,
      });

      const keybindingRule = decodeProjectScriptKeybindingRule({
        keybinding: input.keybinding,
        command: input.keybindingCommand,
      });

      if (isElectron && keybindingRule) {
        await api.server.upsertKeybinding(keybindingRule);
        await queryClient.invalidateQueries({ queryKey: serverQueryKeys.all });
      }
    },
    [queryClient],
  );

  const runProjectScript = useCallback(
    (script: ProjectScript) => {
      const api = readNativeApi();
      if (!api || !activeProject) return;
      void api.terminal.write({
        threadId,
        terminalId: terminalState.activeTerminalId,
        data: `${script.command}\r`,
      });
      // Track last invoked (Feature 6)
      setLastInvokedScriptByProjectId((current) => {
        if (current[activeProject.id] === script.id) return current;
        return { ...current, [activeProject.id]: script.id };
      });
    },
    [activeProject, threadId, terminalState.activeTerminalId, setLastInvokedScriptByProjectId],
  );

  const saveProjectScript = useCallback(
    async (input: NewProjectScriptInput) => {
      if (!activeProject) return;
      const nextId = nextProjectScriptId(
        input.name,
        activeProject.scripts.map((script) => script.id),
      );
      const nextScript: ProjectScript = {
        id: nextId,
        name: input.name,
        command: input.command,
        icon: input.icon,
        runOnWorktreeCreate: input.runOnWorktreeCreate,
      };
      const nextScripts = input.runOnWorktreeCreate
        ? [
            ...activeProject.scripts.map((script) =>
              script.runOnWorktreeCreate ? { ...script, runOnWorktreeCreate: false } : script,
            ),
            nextScript,
          ]
        : [...activeProject.scripts, nextScript];

      await persistProjectScripts({
        projectId: activeProject.id,
        projectCwd: activeProject.cwd,
        previousScripts: activeProject.scripts,
        nextScripts,
        keybinding: input.keybinding,
        keybindingCommand: commandForProjectScript(nextId),
      });
    },
    [activeProject, persistProjectScripts],
  );

  const updateProjectScript = useCallback(
    async (scriptId: string, input: NewProjectScriptInput) => {
      if (!activeProject) return;
      const existingScript = activeProject.scripts.find((script) => script.id === scriptId);
      if (!existingScript) return;

      const updatedScript: ProjectScript = {
        ...existingScript,
        name: input.name,
        command: input.command,
        icon: input.icon,
        runOnWorktreeCreate: input.runOnWorktreeCreate,
      };
      const nextScripts = activeProject.scripts.map((script) =>
        script.id === scriptId
          ? updatedScript
          : input.runOnWorktreeCreate
            ? { ...script, runOnWorktreeCreate: false }
            : script,
      );

      await persistProjectScripts({
        projectId: activeProject.id,
        projectCwd: activeProject.cwd,
        previousScripts: activeProject.scripts,
        nextScripts,
        keybinding: input.keybinding,
        keybindingCommand: commandForProjectScript(scriptId),
      });
    },
    [activeProject, persistProjectScripts],
  );

  const deleteProjectScript = useCallback(
    async (scriptId: string) => {
      if (!activeProject) return;
      const nextScripts = activeProject.scripts.filter((script) => script.id !== scriptId);
      const deletedName = activeProject.scripts.find((s) => s.id === scriptId)?.name;

      try {
        await persistProjectScripts({
          projectId: activeProject.id,
          projectCwd: activeProject.cwd,
          previousScripts: activeProject.scripts,
          nextScripts,
          keybinding: null,
          keybindingCommand: commandForProjectScript(scriptId),
        });
        toastManager.add({
          type: "success",
          title: `Deleted action "${deletedName ?? "Unknown"}"`,
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Could not delete action",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        });
      }
    },
    [activeProject, persistProjectScripts],
  );

  const onToggleDiff = useCallback(() => {
    void navigate({
      to: "/$threadId",
      params: { threadId },
      replace: true,
      search: diffOpen ? { diff: undefined } : { diff: "1" },
    });
  }, [navigate, threadId, diffOpen]);

  const onEnvModeChange = useCallback(
    (mode: string) => {
      if (!isServerThread && draftThread) {
        useComposerDraftStore
          .getState()
          .setDraftThreadContext(threadId, { envMode: mode as "local" | "worktree" });
      }
    },
    [isServerThread, draftThread, threadId],
  );

  // --- Keyboard shortcuts ---

  useEffect(() => {
    if (!isServerThread) return;

    const isMac = navigator.platform.startsWith("Mac") || navigator.userAgent.includes("Mac");

    const handleKeyDown = (event: KeyboardEvent) => {
      const mod = isMac ? event.metaKey : event.ctrlKey;
      if (!mod) return;

      const key = event.key.toLowerCase();

      // Cmd+\ → split vertical (side by side)
      if (key === "\\" && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        handleSplitTerminal();
        return;
      }

      // Cmd+/ → split (same as Cmd+\, horizontal layout not supported by terminal drawer)
      if (key === "/" && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        handleSplitTerminal();
        return;
      }

      if (key === "t" && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        if (activeProject) {
          void handleNewThread(activeProject.id as ProjectId);
        }
        return;
      }

      if (key === "w" && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        handleCloseTerminal(terminalState.activeTerminalId);
        return;
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [
    isServerThread,
    handleSplitTerminal,
    handleNewThread,
    handleCloseTerminal,
    terminalState.activeTerminalId,
    activeProject,
  ]);

  // --- Render ---

  if (!activeProject) {
    return null;
  }

  if (!isServerThread) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
        <header
          className={cn(
            "border-b border-border px-3 sm:px-5",
            isElectron
              ? "drag-region flex h-[52px] items-center"
              : "flex items-center py-2 sm:py-3",
          )}
        >
          <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
            <SidebarTrigger className="size-7 shrink-0 md:hidden" />
            <span className="text-sm text-muted-foreground">Starting terminal...</span>
          </div>
        </header>
        <div className="flex flex-1 items-center justify-center">
          <span className="text-sm text-muted-foreground">Connecting...</span>
        </div>
      </div>
    );
  }

  const threadTitle = thread?.title ?? "Terminal";

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
      {/* Header bar with toolbar */}
      <header
        className={cn(
          "border-b border-border px-3 sm:px-5",
          isElectron ? "drag-region flex h-[52px] items-center" : "flex items-center py-2 sm:py-3",
        )}
      >
        <ChatHeader
          activeThreadId={threadId}
          activeThreadTitle={threadTitle}
          activeProjectName={activeProject.name}
          isGitRepo={isGitRepo}
          openInCwd={gitCwd}
          activeProjectScripts={activeProject.scripts}
          preferredScriptId={preferredScriptId}
          keybindings={keybindings}
          availableEditors={availableEditors}
          diffToggleShortcutLabel={diffShortcutLabel}
          gitCwd={gitCwd}
          diffOpen={diffOpen}
          onRunProjectScript={runProjectScript}
          onAddProjectScript={saveProjectScript}
          onUpdateProjectScript={updateProjectScript}
          onDeleteProjectScript={deleteProjectScript}
          onToggleDiff={onToggleDiff}
        />
      </header>

      {/* Terminal */}
      <div
        ref={containerRef}
        className="relative min-h-0 flex-1 overflow-hidden [&_.thread-terminal-drawer]:!border-t-0 [&_.thread-terminal-drawer>.absolute.z-20:first-child]:hidden [&_.thread-terminal-drawer>.pointer-events-none.absolute]:hidden [&_aside.w-36]:hidden"
      >
        <ThreadTerminalDrawer
          key={threadId}
          threadId={threadId}
          cwd={cwd}
          height={containerHeight}
          terminalIds={terminalState.terminalIds}
          activeTerminalId={terminalState.activeTerminalId}
          terminalGroups={terminalState.terminalGroups}
          activeTerminalGroupId={terminalState.activeTerminalGroupId}
          focusRequestId={focusRequestId}
          onSplitTerminal={handleSplitTerminal}
          onNewTerminal={handleNewTerminal}
          splitShortcutLabel={splitShortcutLabel ?? undefined}
          newShortcutLabel={newShortcutLabel ?? undefined}
          closeShortcutLabel={closeShortcutLabel ?? undefined}
          onActiveTerminalChange={handleActiveTerminalChange}
          onCloseTerminal={handleCloseTerminal}
          onHeightChange={handleHeightChange}
          onAddTerminalContext={handleAddTerminalContext}
        />
      </div>

      {/* BranchToolbar — shows git branch, env mode (Feature 2) */}
      {isGitRepo && (
        <BranchToolbar threadId={threadId} onEnvModeChange={onEnvModeChange} envLocked={envLocked} />
      )}
    </div>
  );
}
