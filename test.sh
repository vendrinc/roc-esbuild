#!/bin/bash

# Why this is a shell script: https://twitter.com/rtfeldman/status/1668776290021949444

set -e

os_name=$(uname)

# Directory of the script itself
script_dir=$(readlink -f "$(dirname "$0")")
test_dir=$script_dir/tests

if [ "$os_name" = "Linux" ]; then
    echo "Running npm install to refresh roc-esbuild and tests"
    rm -rf node_modules
    npm install
    cd "$test_dir"
    rm -rf node_modules
    npm install

    echo "Running tests"

    # Loop over all .js files
    for file in "$test_dir"/*.js
    do
        printf "\tRunning %s\n" "$file"
        node "$file" && printf "Passed: \t%s\n" "$file"
    done
fi

if [ "$os_name" != "Linux" ]; then
    printf "\nRe-running tests in Docker to verify they pass on Linux\n\n"

    # Build the docker image, storing output in a tempfile and then printing it only if it failed.
    docker_image_name=roc-esbuild-tests

    docker build -t $docker_image_name "$test_dir"

    # Run the tests again in Docker
    # Specify --platform explicitly because Docker gives a warning if the one specified
    # in the Dockerfile is different from the one you're running on your system.
    docker run --platform=linux/amd64 -v "$script_dir:/app" $docker_image_name
fi
