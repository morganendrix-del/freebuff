import { QueryClient, queryOptions } from "@tanstack/react-query";
import type { Id } from "@freebuff/shared";
import type { PlatformClient } from "@freebuff/sdk";

export const queryKeys = {
  user: () => ["user"] as const,
  projects: () => ["projects"] as const,
  sessions: (projectId?: string) => ["sessions", projectId ?? "all"] as const,
  session: (sessionId: string) => ["session", sessionId] as const,
  quota: () => ["quota"] as const,
  ad: (tags: readonly string[]) => ["ad", [...tags]] as const,
};

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 5_000, refetchOnWindowFocus: false },
    },
  });
}

/** Query options bound to a platform client. Server state only; nothing here decides access. */
export function platformQueries(client: PlatformClient) {
  return {
    user: () => queryOptions({ queryKey: queryKeys.user(), queryFn: () => client.auth.me() }),
    projects: () =>
      queryOptions({ queryKey: queryKeys.projects(), queryFn: () => client.projects.list() }),
    sessions: (projectId?: Id<"project">) =>
      queryOptions({
        queryKey: queryKeys.sessions(projectId),
        queryFn: () => client.sessions.list(projectId),
      }),
    session: (sessionId: Id<"session">) =>
      queryOptions({
        queryKey: queryKeys.session(sessionId),
        queryFn: () => client.sessions.get(sessionId),
      }),
    quota: () =>
      queryOptions({ queryKey: queryKeys.quota(), queryFn: () => client.quota.snapshot() }),
    ad: (contextTags: readonly string[]) =>
      queryOptions({
        queryKey: queryKeys.ad(contextTags),
        queryFn: () => client.ads.select({ surface: "cli", contextTags }),
      }),
  };
}
