#!/usr/bin/env python3

# This script checks for the file "BuildVersion.h" and replaces it with the
# correct semver numbers from the git history (these are inputs)

import fileinput
import sys

def main(major, minor, patch, build):
    buildVersionFileName = 'BuildVersion.h'

    for line in fileinput.input(buildVersionFileName, inplace = 1):
        if "major" in line:
            print(line.replace("0", major).rstrip())
        elif "minor" in line:
            print(line.replace("0", minor).rstrip())
        elif "patch" in line:
            print(line.replace("0", patch).rstrip())
        elif "build" in line:
            print(line.replace("0", build).rstrip())
        else:
            print(line.rstrip())


if __name__ == '__main__':
    # Get major, minor, and patch versions from inputs
    if len(sys.argv) != 5:
        sys.exit("Correct usage: script.py <major version> <minor number> <patch number>")

    major = sys.argv[1]
    minor = sys.argv[2]
    patch = sys.argv[3]
    build = sys.argv[4]

    main(major, minor, patch, build)
