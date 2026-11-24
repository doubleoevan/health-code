# Design

## One setting

The path is part of `HEALTH_CODE_MODEL_HOST`. A path is normalized and replaces `/v1`. An address without one uses `/v1`, so existing settings keep their endpoint.

## Credentials

The stored key stays named for the origin. Each binding covers one exact host and inference path. Queries, fragments, ports, wildcards and encoded characters that remain after normalization are rejected.
