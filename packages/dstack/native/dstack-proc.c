/*
 * dstack-proc: macOS process-ownership backend for dstackd.
 *
 * `start` is opaque: it is formatted "<pbi_start_tvsec>.<pbi_start_tvusec>" and only ever
 * compared for equality against a freshly formatted value. It is never parsed.
 */

#include <errno.h>
#include <libproc.h>
#include <limits.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc.h>
#include <sys/proc_info.h>
#include <sys/sysctl.h>
#include <sys/types.h>
#include <unistd.h>

#define TOKEN_KEY "DSTACK_PROCESS_TOKEN"
#define SCOPE_KEY "DSTACK_PROCESS_SCOPE"
#define ENV_LIMIT (4 * 1024 * 1024)

struct owned_process {
  pid_t pid;
  char start[64];
};

static void format_start(char *out, size_t cap, const struct proc_bsdinfo *info) {
  snprintf(out, cap, "%llu.%llu", (unsigned long long)info->pbi_start_tvsec,
           (unsigned long long)info->pbi_start_tvusec);
}

static bool proc_info(pid_t pid, struct proc_bsdinfo *info) {
  return proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, info, (int)sizeof *info) == (int)sizeof *info;
}

static bool env_holds(pid_t pid, const char *key, const char *token) {
  int mib[3] = { CTL_KERN, KERN_PROCARGS2, (int)pid };
  size_t size = 0;
  if (sysctl(mib, 3, NULL, &size, NULL, 0) != 0 || size <= sizeof(int) || size > ENV_LIMIT)
    return false;
  char *buffer = malloc(size);
  if (!buffer) return false;
  if (sysctl(mib, 3, buffer, &size, NULL, 0) != 0) {
    free(buffer);
    return false;
  }
  int argc = 0;
  memcpy(&argc, buffer, sizeof argc);
  char *p = buffer + sizeof(int);
  char *end = buffer + size;
  while (p < end && *p) p++;
  while (p < end && *p == '\0') p++;
  for (int index = 0; index < argc && p < end; index++) {
    while (p < end && *p) p++;
    while (p < end && *p == '\0') p++;
  }
  char wanted[512];
  if (snprintf(wanted, sizeof wanted, "%s=%s", key, token) >= (int)sizeof wanted) {
    free(buffer);
    return false;
  }
  size_t wanted_length = strlen(wanted);
  bool found = false;
  while (p < end && *p) {
    char *nul = memchr(p, '\0', (size_t)(end - p));
    if (!nul) break;
    if ((size_t)(nul - p) == wanted_length && memcmp(p, wanted, wanted_length) == 0) {
      found = true;
      break;
    }
    p = nul + 1;
  }
  free(buffer);
  return found;
}

static struct kinfo_proc *all_processes(size_t *count) {
  int mib[4] = { CTL_KERN, KERN_PROC, KERN_PROC_ALL, 0 };
  size_t size = 0;
  if (sysctl(mib, 4, NULL, &size, NULL, 0) != 0) return NULL;
  for (int attempt = 0; attempt < 4; attempt++) {
    size_t capacity = size + 32 * sizeof(struct kinfo_proc);
    struct kinfo_proc *processes = malloc(capacity);
    if (!processes) return NULL;
    size_t used = capacity;
    if (sysctl(mib, 4, processes, &used, NULL, 0) == 0) {
      *count = used / sizeof(struct kinfo_proc);
      return processes;
    }
    free(processes);
    if (errno != ENOMEM) return NULL;
    size = used;
  }
  return NULL;
}

static int scan_owned(const char *key, const char *token, struct owned_process **out,
                      size_t *count) {
  *out = NULL;
  *count = 0;
  size_t total = 0;
  struct kinfo_proc *all = all_processes(&total);
  if (!all) return -1;
  struct owned_process *owned = NULL;
  size_t used = 0;
  for (size_t index = 0; index < total; index++) {
    pid_t pid = all[index].kp_proc.p_pid;
    if (pid <= 0) continue;
    struct proc_bsdinfo info;
    if (!proc_info(pid, &info)) continue;
    if (info.pbi_uid != getuid() || info.pbi_status == SZOMB) continue;
    if (!env_holds(pid, key, token)) continue;
    struct owned_process *grown = realloc(owned, (used + 1) * sizeof *owned);
    if (!grown) {
      free(owned);
      free(all);
      return -1;
    }
    owned = grown;
    owned[used].pid = pid;
    format_start(owned[used].start, sizeof owned[used].start, &info);
    used++;
  }
  free(all);
  *out = owned;
  *count = used;
  return 0;
}

static int cmd_owned(const char *key, const char *token) {
  struct owned_process *owned = NULL;
  size_t count = 0;
  if (scan_owned(key, token, &owned, &count) != 0) {
    fprintf(stderr, "dstack-proc owned: cannot enumerate processes\n");
    return 1;
  }
  printf("[");
  for (size_t index = 0; index < count; index++) {
    printf("%s{\"pid\":%d,\"start\":\"%s\"}", index ? "," : "", (int)owned[index].pid,
           owned[index].start);
  }
  printf("]\n");
  free(owned);
  return 0;
}

static int cmd_signal(pid_t pid, const char *start, const char *key, const char *token,
                      const char *action) {
  int number = strcmp(action, "SIGKILL") == 0 ? SIGKILL : SIGTERM;
  struct proc_bsdinfo info;
  if (!proc_info(pid, &info)) return 0;
  if (info.pbi_uid != getuid() || info.pbi_status == SZOMB) return 0;
  char actual[64];
  format_start(actual, sizeof actual, &info);
  if (strcmp(actual, start) != 0) return 0;
  if (!env_holds(pid, key, token)) return 0;
  if (kill(pid, number) != 0 && errno != ESRCH) {
    perror("kill");
    return 1;
  }
  return 0;
}

static int cmd_verify(void) {
  const char *name = "DSTACK_PROC_VERIFY";
  const char *value = "1";
  if (setenv(name, value, 1) != 0) {
    fprintf(stderr, "dstack-proc verify: cannot set %s\n", name);
    return 1;
  }
  if (!env_holds(getpid(), name, value)) {
    fprintf(stderr, "dstack-proc verify: cannot read this process's environment\n");
    return 1;
  }
  struct owned_process *owned = NULL;
  size_t count = 0;
  if (scan_owned(name, value, &owned, &count) != 0) {
    fprintf(stderr, "dstack-proc verify: cannot enumerate processes\n");
    return 1;
  }
  bool found = false;
  for (size_t index = 0; index < count; index++) {
    if (owned[index].pid == getpid()) found = true;
  }
  free(owned);
  if (!found) {
    fprintf(stderr, "dstack-proc verify: enumeration did not find this process\n");
    return 1;
  }
  return 0;
}

static int usage(void) {
  fprintf(stderr,
          "usage: dstack-proc owned %s|%s <token>\n"
          "       dstack-proc signal <pid> <start> %s|%s <token> SIGTERM|SIGKILL\n"
          "       dstack-proc verify\n",
          TOKEN_KEY, SCOPE_KEY, TOKEN_KEY, SCOPE_KEY);
  return 2;
}

int main(int argc, char **argv) {
  if (argc < 2) return usage();
  if (strcmp(argv[1], "owned") == 0) {
    if (argc != 4) return usage();
    return cmd_owned(argv[2], argv[3]);
  }
  if (strcmp(argv[1], "signal") == 0) {
    if (argc != 7) return usage();
    char *end = NULL;
    long pid = strtol(argv[2], &end, 10);
    if (!end || *end || pid <= 0 || pid > INT_MAX) return usage();
    return cmd_signal((pid_t)pid, argv[3], argv[4], argv[5], argv[6]);
  }
  if (strcmp(argv[1], "verify") == 0) {
    if (argc != 2) return usage();
    return cmd_verify();
  }
  return usage();
}
