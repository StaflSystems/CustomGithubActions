#!/usr/bin/env python3
# This python script will build a project with stafllib

import os
import subprocess
import sys

eclipse_path = 'C:/ti/ccs1100/ccs/eclipse/eclipsec.exe'
project_name = str(sys.argv[1])
os.chdir("..")

workspace = os.getcwd()


# Import the main project
import_command = "{} -noSplash -data {} -application com.ti.ccstudio.apps.projectImport -ccs.location {}\{} -ccs.overwrite".format(eclipse_path, workspace, workspace, project_name)
os.system(import_command)

# Import stafllib
submodule_import_command = "{} -noSplash -data {} -application com.ti.ccstudio.apps.projectImport -ccs.location {}\{}\stafllib -ccs.overwrite".format(eclipse_path, workspace, workspace, project_name)
os.system(submodule_import_command)

# Build project
build_command = "{} -noSplash -data {} -application com.ti.ccstudio.apps.projectBuild -ccs.projects {} -ccs.configuration Debug-Stafl".format(eclipse_path, workspace, project_name)
os.system(build_command)
