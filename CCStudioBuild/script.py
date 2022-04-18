#!/usr/bin/env python3
# This python script will build a project with stafllib

import os
import subprocess
import sys


def main(project_name, build_configs):
        # We need to be one directory up to simplify paths
    os.chdir("..")
    
    eclipse_path = 'C:/ti/ccs1100/ccs/eclipse/eclipsec.exe'
    workspace = os.getcwd()

    # Import the main project
    import_command = "{} -noSplash -data {} -application com.ti.ccstudio.apps.projectImport -ccs.location " \
                     "{}\{} -ccs.overwrite".format(eclipse_path, workspace, workspace, project_name)
    print(import_command)
    if os.system(import_command) != 0:
        raise RuntimeError

    # Import stafllib
    # Note: We first check if stafllib is being used in this project in the first place
    #       To do this, we just check to see if the folder exists before importing it
    possible_stafllib_path = workspace + "\\" + project_name + "\\stafllib"
    if (os.path.isdir(possible_stafllib_path)):
        submodule_import_command = "{} -noSplash -data {} -application com.ti.ccstudio.apps.projectImport -ccs.location " \
                                "{}\{}\stafllib -ccs.overwrite".format(eclipse_path, workspace, workspace, project_name)
        print(submodule_import_command)
        if os.system(submodule_import_command) != 0:
            raise RuntimeError

    # Build project
    for config in build_configs:
        build_command = "{} -noSplash -data {} -application com.ti.ccstudio.apps.projectBuild -ccs.projects {} " \
                        "-ccs.configuration {}".format(eclipse_path, workspace, project_name, config)
        print(build_command)
        if os.system(build_command) != 0:
            raise RuntimeError


if __name__ == '__main__':
    # We first make sure we have the right amount of arguments
    if len(sys.argv) != 3:
        sys.exit("Invalid usage. Correct usage: ./script.py <project_name> <build_config>")

    project_name = sys.argv[1]
    print(sys.argv[2])
    build_configs = sys.argv[2].split(",")

    main(project_name, build_configs)
