def digest: type == "string" and test("\\A[0-9a-f]{64}\\z");
def nonempty: type == "string" and length > 0;
def service:
  type == "object" and
  (.reviewDigest | digest) and
  if .state == "fresh" then
    keys == ["reviewDigest", "state"]
  elif .state == "restored" then
    keys == ["backupDigest", "procedureVersion", "reviewDigest", "sourceVersion", "state"] and
    (.backupDigest | digest) and (.sourceVersion | nonempty) and (.procedureVersion | nonempty)
  else false end;
length == 1 and (.[0] |
  type == "object" and
  keys == ["machineId", "mediaIdentity", "services", "version"] and
  .version == 1 and .machineId == $machineId and .mediaIdentity == $mediaIdentity and
  (.services | type == "object" and keys == ($units | sort) and all(.[]; service)))
