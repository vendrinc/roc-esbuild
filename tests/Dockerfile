FROM --platform=linux/amd64 haskell:9.2.2
WORKDIR /app

RUN apt-get update
RUN apt-get -y install curl python3 strace

# Install NVM
RUN curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash

# Activate NVM
ENV NVM_DIR=/root/.nvm
RUN . "$NVM_DIR/nvm.sh" && nvm install 16.16.0

# Add node and npm to path so the commands are available
ENV NODE_PATH $NVM_DIR/versions/node/v16.16.0/lib/node_modules
ENV PATH      $NVM_DIR/versions/node/v16.16.0/bin:$PATH

# Confirm installation
RUN node -v
RUN npm -v

CMD bash test.sh
