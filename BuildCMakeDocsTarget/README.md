# Build CMake Docs Target

This action builds a CMake target for documentation, zips up the output, and creates or updates a release's files with the zip file. The tag creation is controlled by the `create-tag` input, and can be disabled for PR builds.

This action can be used as part of a dependent job in an existing workflow that creates a release by using the [`needs` job property](https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions#jobsjob_idneeds).