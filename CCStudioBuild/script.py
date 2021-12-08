#!/usr/bin/env python3
# This python script will build a project with stafllib

import os
import subprocess
import sys


def main(project_name, build_config):
        # We need to be one directory up to simplify paths
    os.chdir("..")
    
    eclipse_path = 'C:/ti/ccs1100/ccs/eclipse/eclipsec.exe'
    workspace = os.getcwd()

    # Import the main project
    import_command = "{} -noSplash -data {} -application com.ti.ccstudio.apps.projectImport -ccs.location " \
                     "{}\{} -ccs.overwrite".format(eclipse_path, workspace, workspace, project_name)
    if os.system(import_command) != 0:
        raise RuntimeError

    # Import stafllib
    # Note: If we're building stafllib itself, we don't need to do this
    if (project_name.lower() != "stafllib"):
        submodule_import_command = "{} -noSplash -data {} -application com.ti.ccstudio.apps.projectImport -ccs.location " \
                                "{}\{}\stafllib -ccs.overwrite".format(eclipse_path, workspace, workspace, project_name)
        if os.system(submodule_import_command) != 0:
            raise RuntimeError

    # Build project
    build_command = "{} -noSplash -data {} -application com.ti.ccstudio.apps.projectBuild -ccs.projects {} " \
                    "-ccs.configuration {}".format(eclipse_path, workspace, project_name, build_config)
    if os.system(build_command) != 0:
        raise RuntimeError


if __name__ == '__main__':
    # We first make sure we have the right amount of arguments
    if len(sys.argv) != 3:
        sys.exit("Invalid usage. Correct usage: ./script.py <project_name> <build_config>")

    project_name = sys.argv[1]
    build_config = sys.argv[2]

    main(project_name, build_config)