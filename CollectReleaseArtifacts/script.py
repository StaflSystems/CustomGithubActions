#!/usr/bin/env python3

# This script collects release artifacts in a folder and appends the version to their name.

from os import mkdir
import sys
from pathlib import Path
from genericpath import exists
from typing import List
from shutil import copyfile


def main(version: str, globbing_patterns: str, destination: str):
    current_dir = Path(".")
    destination_dir = Path(destination)
    destination_dir.mkdir(parents=True, exist_ok=True)

    artifacts: List[Path] = []
    for pattern in globbing_patterns.split(","):
        artifacts += list(current_dir.glob(pattern))

    for artifact in artifacts:
        destination_filename = str(destination_dir /
                                   f"{artifact.stem}_{version}{artifact.suffix}")
        if (exists(destination_filename)):
            destination_filename = str(destination_dir /
                                       f"{artifact.parents[0]}{artifact.stem}_{version}{artifact.suffix}".replace('/', '_'))
        copyfile(
            str(artifact),
            destination_filename
        )

if __name__ == "__main__":
    if len(sys.argv) != 4:
        sys.exit(
            "Correct usage: script.py <version> <artifact globbing patterns> <destination>"
        )

    version = sys.argv[1]
    globbing_patterns = sys.argv[2]
    destination = sys.argv[3]

    main(version, globbing_patterns, destination)
