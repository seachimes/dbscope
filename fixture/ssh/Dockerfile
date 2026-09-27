FROM alpine:3.20

RUN apk add --no-cache openssh-server mysql-client \
 && ssh-keygen -A \
 && adduser -D -s /bin/sh appuser \
 && passwd -u appuser \
 && mkdir -p /home/appuser/.ssh \
 && chmod 700 /home/appuser/.ssh

# Key-only auth, and forwarding limited to exactly the two databases behind it:
# DBSCOPE needs nothing else, and a broader grant would make this container a
# general-purpose pivot into whatever network it happens to run on.
RUN printf '%s\n' \
      'PermitRootLogin no' \
      'PasswordAuthentication no' \
      'PubkeyAuthentication yes' \
      'AllowTcpForwarding yes' \
      'GatewayPorts no' \
      'AllowAgentForwarding no' \
      'PermitOpen mysql:3306 postgres:5432' \
      'LogLevel INFO' \
    > /etc/ssh/sshd_config.d/dbscope-fixture.conf

COPY ssh/id_ed25519.pub /home/appuser/.ssh/authorized_keys
RUN chown -R appuser:appuser /home/appuser/.ssh \
 && chmod 600 /home/appuser/.ssh/authorized_keys

EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
