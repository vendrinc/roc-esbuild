#!/bin/bash

# Why this is a shell script: https://twitter.com/rtfeldman/status/1668776290021949444

set -e

os_name=$(uname)

# Directory of the script itself
script_dir=$(readlink -f "$(dirname "$0")")
test_dir=$script_dir/tests

if [ "$os_name" = "Linux" ]; then
    # We're running in Docker

    # First, run all the cross-compiled output code before rebuilding locally without cross-compilation
    for dir in "$test_dir"/*/
    do
        # Don't treat node_modules as a test dir
        case "$dir" in
        *"node_modules"*) continue;;
        esac

        printf "\n⭐️ Running cross-compiled test: %s\n\n" "$dir"
        node "$dir/dist/output.js" && printf "\n⭐️ Passed: %s\n\n" "$dir"
    done

    # Now rebuild everything locally and try that (without cross-compilation).
    echo "Running npm install to refresh roc-esbuild and tests"
    rm -rf node_modules
    npm install
    cd "$test_dir"
    rm -rf node_modules
    npm install

    echo "Running tests"

    for dir in "$test_dir"/*/
    do
        # Don't treat node_modules as a test dir
        case "$dir" in
        *"node_modules"*) continue;;
        esac

        printf "\n⭐️ Building test using roc-esbuild plugin: %s\n\n" "$dir"
        node "$test_dir/build.js" "$dir" && printf "\n⭐️ Build succeeded: %s\n\n" "$dir"
        printf "\n⭐️ Running compiled test: %s\n\n" "$dir"
        node "$dir/dist/output.js" && printf "\n⭐️ Passed: %s\n\n" "$dir"
    done
else
    # We're running in macOS, so cross-compile
    echo "Running npm install to refresh roc-esbuild and tests"
    rm -rf node_modules
    npm install
    cd "$test_dir"
    rm -rf node_modules
    npm install

    echo "Cross-compiling tests using zig cc..."

    for dir in "$test_dir"/*/
    do
        # Don't treat node_modules as a test dir
        case "$dir" in
        *"node_modules"*) continue;;
        esac

        printf "\n⭐️ Cross-compiling test using roc-esbuild plugin with zig cc: %s\n\n" "$dir"
        node "$test_dir/build.js" "$dir" --cross-compile && printf "\n⭐️ Cross-compiled build succeeded: %s\n\n" "$dir"
    done
fi

if [ "$os_name" != "Linux" ]; then
    printf "\nRunning tests in Docker to verify they pass on Linux\n\n"

    # Build the docker image, storing output in a tempfile and then printing it only if it failed.
    docker_image_name=roc-esbuild-tests

   docker build -t $docker_image_name "$test_dir"

    # Run the tests again in Docker
    # Specify --platform explicitly because Docker gives a warning if the one specified
    # in the Dockerfile is different from the one you're running on your system.
    docker run --platform=linux/amd64 -v "$script_dir:/app" $docker_image_name
fi
