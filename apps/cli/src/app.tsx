import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { useKeyboard } from "@opentui/react";
import type { LlmProvider } from "@freebuff/llm-providers";
import type { PlatformClient } from "@freebuff/sdk";
import { QuotaMirror } from "@freebuff/quota";
import type { AgentMessage, QuotaSnapshot } from "@freebuff/shared";

import { runChatTurn } from "./flows/chat";
import { signIn } from "./flows/login";
import type { ConfigStore } from "./config";
import type { CliState, CliStore } from "./state";
import { applyAgentEvent } from "./state";
import { QuotaBar } from "./ui/quota-bar";
import { SponsoredSlot } from "./ui/sponsored-slot";

export interface AppProps {
  readonly store: CliStore;
  readonly configStore: ConfigStore;
  readonly client: PlatformClient;
  readonly projectRoot: string;
  readonly provider: LlmProvider | undefined;
  readonly authenticated: boolean;
  readonly onExit: () => void;
}

export function App({
  store,
  configStore,
  client,
  projectRoot,
  provider,
  authenticated,
  onExit,
}: AppProps): ReactNode {
  const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store]);
  const getSnapshot = useCallback(() => store.getState(), [store]);
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const [draft, setDraft] = useState("");
  const [email, setEmail] = useState("");
  const [pickerIndex, setPickerIndex] = useState(0);

  useKeyboard((key) => {
    if (key.raw === "\u0003") onExit();
  });

  useEffect(() => {
    if (!authenticated) return;
    let cancelled = false;
    const isCancelled = (): boolean => cancelled;
    void (async () => {
      const [projects, quota, ad] = await Promise.all([
        client.projects.list(),
        client.quota.snapshot(),
        client.ads.select({ surface: "cli", contextTags: ["code"] }),
      ]);
      if (isCancelled()) return;
      store.setState((previous) => ({
        ...previous,
        phase: projects.length > 0 ? "picking_project" : "ready",
        projects,
        quota,
        ad,
        statusLine: projects.length > 0 ? "Pick a project to continue." : "Ready.",
      }));
    })();
    return () => {
      cancelled = true;
    };
  }, [authenticated, client, store]);

  const submitPrompt = async (prompt: string): Promise<void> => {
    if (provider === undefined) {
      store.setState({ statusLine: "No provider key configured. Set the provider API key first." });
      return;
    }
    const project = state.activeProject;
    if (project === undefined) {
      store.setState({ statusLine: "Pick a project first." });
      return;
    }

    store.setState({ running: true, streamingText: "", statusLine: "Starting…" });

    try {
      const turn = await runChatTurn({
        client,
        projectRoot: project.rootPath,
        prompt,
        provider,
        ...(state.activeSessionId === undefined ? {} : { sessionId: state.activeSessionId }),
        onEvent: (event) => {
          store.setState((previous) => applyAgentEvent(previous, event));
        },
      });

      const quota = await client.quota.snapshot();
      store.setState({
        running: false,
        streamingText: "",
        activeSessionId: turn.session.id,
        messages: turn.session.messages,
        quota,
        statusLine: `Done · ${String(turn.result.steps)} step(s)`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "The run failed.";
      store.setState({ running: false, streamingText: "", statusLine: message });
    }
  };

  const pickProject = async (projectId: string): Promise<void> => {
    const project = state.projects.find((entry) => entry.id === projectId);
    if (project === undefined) return;
    const sessions = await client.sessions.list(project.id);
    store.setState({
      phase: "ready",
      activeProject: project,
      sessions,
      statusLine: `Project ${project.name} · ${String(sessions.length)} session(s)`,
    });
  };

  return (
    <box flexDirection="column" flexGrow={1} padding={1} gap={1}>
      <Header state={state} projectRoot={projectRoot} />

      {state.phase === "signed_out" ? (
        <box flexDirection="column" gap={1}>
          <text fg="#9aa0a6">Sign in with your email to start a session.</text>
          <input
            focused
            placeholder="you@example.com"
            value={email}
            onInput={setEmail}
            onSubmit={(value: string) => {
              void (async () => {
                try {
                  const result = await signIn({ store: configStore, client, email: value });
                  store.setState({
                    user: result.user,
                    phase: "picking_project",
                    statusLine: `Signed in as ${result.user.email}`,
                  });
                } catch (error) {
                  store.setState({
                    statusLine: error instanceof Error ? error.message : "Sign-in failed.",
                  });
                }
              })();
            }}
          />
        </box>
      ) : null}

      {state.phase === "picking_project" ? (
        <box flexDirection="column" gap={1}>
          <text fg="#9aa0a6">Choose a project</text>
          <select
            focused
            options={state.projects.map((project) => ({
              name: project.name,
              description: project.rootPath,
              value: project.id,
            }))}
            selectedIndex={pickerIndex}
            onChange={(index) => {
              setPickerIndex(index);
            }}
            onSelect={(_index, option) => {
              if (option !== null) void pickProject(String(option.value ?? ""));
            }}
          />
        </box>
      ) : null}

      {state.phase === "ready" ? (
        <box flexDirection="column" flexGrow={1} gap={1}>
          <MessageList
            messages={state.messages}
            streamingText={state.streamingText}
            statusLine={state.statusLine}
          />
          <input
            focused={!state.running}
            placeholder={state.running ? "Working…" : "Ask for a change…"}
            value={draft}
            onInput={setDraft}
            onSubmit={(value: string) => {
              setDraft("");
              void submitPrompt(value);
            }}
          />
        </box>
      ) : null}

      <box flexDirection="column" gap={1}>
        {state.quota === undefined ? null : <QuotaStatus quota={state.quota} />}
        <SponsoredSlot ad={state.ad ?? null} />
        <text fg="#6b7280">{state.statusLine}</text>
      </box>
    </box>
  );
}

function Header({ state, projectRoot }: { state: CliState; projectRoot: string }): ReactNode {
  const project = state.activeProject?.rootPath ?? projectRoot;
  return (
    <box flexDirection="column">
      <text fg="#e8eaed">freebuff</text>
      <text fg="#6b7280">
        {state.user === undefined ? "signed out" : state.user.email} · {project}
      </text>
    </box>
  );
}

function MessageList({
  messages,
  streamingText,
  statusLine,
}: {
  messages: readonly AgentMessage[];
  streamingText: string;
  statusLine: string;
}): ReactNode {
  const rendered = messages.map((message) => ({
    id: message.id,
    role: message.role,
    text: message.content
      .map((block) => (block.type === "text" ? block.text : `[${block.type}]`))
      .join(" "),
  }));

  return (
    <scrollbox flexGrow={1} flexDirection="column">
      {rendered.map((message) => (
        <box key={message.id} flexDirection="column">
          <text fg={message.role === "user" ? "#6bcb77" : "#9aa0a6"}>{message.role}</text>
          <text>{message.text}</text>
        </box>
      ))}
      {streamingText === "" ? null : <text fg="#e8eaed">{streamingText}</text>}
      <text fg="#6b7280">{statusLine}</text>
    </scrollbox>
  );
}

function QuotaStatus({ quota }: { quota: QuotaSnapshot }): ReactNode {
  const view = useMemo(() => new QuotaMirror(quota).view(), [quota]);
  return <QuotaBar view={view} />;
}

export interface LaunchAppOptions {
  readonly store: CliStore;
  readonly configStore: ConfigStore;
  readonly client: PlatformClient;
  readonly projectRoot: string;
  readonly provider: LlmProvider | undefined;
  readonly authenticated: boolean;
}

/** Boots the OpenTUI renderer. Imported dynamically so headless commands never load native code. */
export async function launchApp(options: LaunchAppOptions): Promise<void> {
  const { createCliRenderer } = await import("@opentui/core");
  const { createRoot } = await import("@opentui/react");

  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  const root = createRoot(renderer);

  const shutdown = (): void => {
    root.unmount();
    renderer.destroy();
  };

  root.render(
    <App
      store={options.store}
      configStore={options.configStore}
      client={options.client}
      projectRoot={options.projectRoot}
      provider={options.provider}
      authenticated={options.authenticated}
      onExit={shutdown}
    />,
  );
}
