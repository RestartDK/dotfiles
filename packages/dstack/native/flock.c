#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>

static int parse_number(const char *text, long *out) {
  char *end = NULL;
  errno = 0;
  long value = strtol(text, &end, 10);
  if (errno != 0 || !end || *end || value < 0 || value > INT_MAX) return -1;
  *out = value;
  return 0;
}

int main(int argc, char **argv) {
  const char *positional = NULL;
  int nonblock = 0;
  int timeout = -1;
  for (int index = 1; index < argc; index++) {
    if (strcmp(argv[index], "--nonblock") == 0) {
      nonblock = 1;
    } else if (strcmp(argv[index], "--timeout") == 0) {
      if (index + 1 >= argc) {
        fprintf(stderr, "flock: --timeout requires a value\n");
        return 2;
      }
      long value = 0;
      if (parse_number(argv[++index], &value) != 0) {
        fprintf(stderr, "flock: invalid timeout: %s\n", argv[index]);
        return 2;
      }
      timeout = (int)value;
    } else if (positional) {
      fprintf(stderr, "flock: unexpected argument: %s\n", argv[index]);
      return 2;
    } else {
      positional = argv[index];
    }
  }
  if (!positional) {
    fprintf(stderr, "flock: requires one file descriptor argument\n");
    return 2;
  }
  long descriptor = 0;
  if (parse_number(positional, &descriptor) != 0) {
    fprintf(stderr, "flock: invalid file descriptor: %s\n", positional);
    return 2;
  }
  struct stat info;
  if (fstat((int)descriptor, &info) != 0) {
    perror("flock: fstat");
    return 1;
  }
  if (!S_ISREG(info.st_mode)) {
    fprintf(stderr, "flock: descriptor %ld is not a regular file\n", descriptor);
    return 1;
  }
  if (nonblock) {
    if (flock((int)descriptor, LOCK_EX | LOCK_NB) != 0) {
      perror("flock");
      return 1;
    }
    return 0;
  }
  if (timeout >= 0) {
    for (int waited = 0; waited <= timeout * 1000; waited += 100) {
      if (flock((int)descriptor, LOCK_EX | LOCK_NB) == 0) return 0;
      if (errno != EWOULDBLOCK) {
        perror("flock");
        return 1;
      }
      usleep(100000);
    }
    fprintf(stderr, "flock: timeout\n");
    return 1;
  }
  if (flock((int)descriptor, LOCK_EX) != 0) {
    perror("flock");
    return 1;
  }
  return 0;
}
