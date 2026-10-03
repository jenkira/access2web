FROM mcr.microsoft.com/devcontainers/python:1-3.11-bookworm

# The base image configures a Yarn apt repository whose signing key is missing, so `apt-get update` fails, and with it every
# dev container feature that installs packages (Node, Docker-in-Docker). This project does not use Yarn, so remove the repository.
RUN rm -f /etc/apt/sources.list.d/yarn.list
